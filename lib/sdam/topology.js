'use strict';
const EventEmitter = require('events');
const ServerDescription = require('./server_description').ServerDescription;
const TopologyDescription = require('./topology_description').TopologyDescription;
const TopologyType = require('./topology_description').TopologyType;
const monitoring = require('./monitoring');
const calculateDurationInMs = require('../utils').calculateDurationInMs;
const MongoTimeoutError = require('../error').MongoTimeoutError;
const Server = require('./server');

// Global state
let globalTopologyCounter = 0;

// Constants
const TOPOLOGY_DEFAULTS = {
  localThresholdMS: 15,
  serverSelectionTimeoutMS: 10000,
  heartbeatFrequencyMS: 30000
};

/**
 * A container of server instances representing a connection to a MongoDB topology.
 *
 * @fires Topology#serverOpening
 * @fires Topology#serverClosed
 * @fires Topology#serverDescriptionChanged
 * @fires Topology#topologyOpening
 * @fires Topology#topologyClosed
 * @fires Topology#topologyDescriptionChanged
 * @fires Topology#serverHeartbeatStarted
 * @fires Topology#serverHeartbeatSucceeded
 * @fires Topology#serverHeartbeatFailed
 */
class Topology extends EventEmitter {
  /**
   * Create a topology
   *
   * @param {Array|String} seedlist a string list, or array of Server instances to connect to
   * @param {Object} [options] Optional settings
   * @param {Number} [options.localThresholdMS=15] The size of the latency window for selecting among multiple suitable servers
   * @param {Number} [options.serverSelectionTimeoutMS=30000] How long to block for server selection before throwing an error
   * @param {Number} [options.heartbeatFrequencyMS=10000] The frequency with which topology updates are scheduled
   */
  constructor(seedlist, options) {
    super();
    seedlist = seedlist || [];
    options = Object.assign({}, TOPOLOGY_DEFAULTS, options);

    const topologyType = topologyTypeFromSeedlist(seedlist, options);
    const topologyId = globalTopologyCounter++;

    const serverDescriptions = seedlist.reduce((result, seed) => {
      const address = seed.port ? `${seed.host}:${seed.port}` : `${seed.host}:27017`;
      result.set(address, new ServerDescription(address));
      return result;
    }, new Map());

    this.s = {
      // the id of this topology
      id: topologyId,
      // passed in options
      options: Object.assign({}, options),
      // initial seedlist of servers to connect to
      seedlist: seedlist,
      // the topology description
      description: new TopologyDescription(
        topologyType,
        serverDescriptions,
        options.replicaset,
        null,
        null,
        options
      ),
      serverSelectionTimeoutMS: options.serverSelectionTimeoutMS,
      heartbeatFrequencyMS: options.heartbeatFrequencyMS,
      ServerClass: options.ServerClass || null /* eventually our Server class, but null for now */
    };
  }

  /**
   * @return A `TopologyDescription` for this topology
   */
  get description() {
    return this.s.description;
  }

  /**
   * Initiate server connect
   *
   * @param {Object} [options] Optional settings
   * @param {Array} [options.auth=null] Array of auth options to apply on connect
   */
  connect(/* options */) {
    // emit SDAM monitoring events
    this.emit('topologyOpening', new monitoring.TopologyOpeningEvent(this.s.id));

    // emit an event for the topology change
    this.emit(
      'topologyDescriptionChanged',
      new monitoring.TopologyDescriptionChangedEvent(
        this.s.id,
        new TopologyDescription(TopologyType.Unknown), // initial is always Unknown
        this.s.description
      )
    );

    connectServers(this, Array.from(this.s.description.servers.keys()));
  }

  /**
   * Close this topology
   */
  close(callback) {
    this.s.servers.forEach(server => {
      server.destroy();
    });

    // emit an event for close
    this.emit('topologyClosed', new monitoring.TopologyClosedEvent(this.s.id));

    if (typeof callback === 'function') {
      callback(null, null);
    }
  }

  /**
   * Selects a server according to the selection predicate provided
   *
   * @param {function} [selector] An optional selector to select servers by, defaults to a random selection within a latency window
   * @return {Server} An instance of a `Server` meeting the criteria of the predicate provided
   */
  selectServer(selector, options, callback) {
    if (typeof options === 'function') (callback = options), (options = {});
    options = Object.assign(
      {},
      { serverSelectionTimeoutMS: this.s.serverSelectionTimeoutMS },
      options
    );

    selectServers(
      this,
      selector,
      options.serverSelectionTimeoutMS,
      process.hrtime(),
      (err, servers) => {
        if (err) return callback(err, null);
        callback(null, randomSelection(servers));
      }
    );
  }

  /**
   * Update the internal TopologyDescription with a ServerDescription
   *
   * @param {object} serverDescription The server to update in the internal list of server descriptions
   */
  serverUpdateHandler(serverDescription) {
    if (!this.s.description.hasServer(serverDescription.address)) {
      return;
    }

    // these will be used for monitoring events later
    const previousTopologyDescription = this.s.description;
    const previousServerDescription = this.s.description.servers.get(serverDescription.address);

    // first update the TopologyDescription
    this.s.description = this.s.description.update(serverDescription);

    // emit monitoring events for this change
    this.emit(
      'serverDescriptionChanged',
      new monitoring.ServerDescriptionChangedEvent(
        this.s.id,
        serverDescription.address,
        previousServerDescription,
        this.s.description.servers.get(serverDescription.address)
      )
    );

    // update server list from updated descriptions
    updateServers(this);

    this.emit(
      'topologyDescriptionChanged',
      new monitoring.TopologyDescriptionChangedEvent(
        this.s.id,
        previousTopologyDescription,
        this.s.description
      )
    );
  }

  /**
   * Authenticate using a specified mechanism
   *
   * @param {String} mechanism The auth mechanism used for authentication
   * @param {String} db The db we are authenticating against
   * @param {Object} options Optional settings for the authenticating mechanism
   * @param {authResultCallback} callback A callback function
   */
  auth(mechanism, db, options, callback) {
    callback(null, null);
  }

  /**
   * Logout from a database
   *
   * @param {String} db The db we are logging out from
   * @param {authResultCallback} callback A callback function
   */
  logout(db, callback) {
    callback(null, null);
  }

  // Basic operation support. Eventually this should be moved into command construction
  // during the command refactor.

  /**
   * Insert one or more documents
   *
   * @param {String} ns The full qualified namespace for this operation
   * @param {Array} ops An array of documents to insert
   * @param {Boolean} [options.ordered=true] Execute in order or out of order
   * @param {Object} [options.writeConcern] Write concern for the operation
   * @param {Boolean} [options.serializeFunctions=false] Specify if functions on an object should be serialized
   * @param {Boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields
   * @param {ClientSession} [options.session] Session to use for the operation
   * @param {boolean} [options.retryWrites] Enable retryable writes for this operation
   * @param {opResultCallback} callback A callback function
   */
  insert(ns, ops, options, callback) {
    callback(null, null);
  }

  /**
   * Perform one or more update operations
   *
   * @param {string} ns The fully qualified namespace for this operation
   * @param {array} ops An array of updates
   * @param {boolean} [options.ordered=true] Execute in order or out of order
   * @param {object} [options.writeConcern] Write concern for the operation
   * @param {Boolean} [options.serializeFunctions=false] Specify if functions on an object should be serialized
   * @param {Boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields
   * @param {ClientSession} [options.session] Session to use for the operation
   * @param {boolean} [options.retryWrites] Enable retryable writes for this operation
   * @param {opResultCallback} callback A callback function
   */
  update(ns, ops, options, callback) {
    callback(null, null);
  }

  /**
   * Perform one or more remove operations
   *
   * @param {string} ns The MongoDB fully qualified namespace (ex: db1.collection1)
   * @param {array} ops An array of removes
   * @param {boolean} [options.ordered=true] Execute in order or out of order
   * @param {object} [options.writeConcern={}] Write concern for the operation
   * @param {Boolean} [options.serializeFunctions=false] Specify if functions on an object should be serialized.
   * @param {Boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
   * @param {ClientSession} [options.session=null] Session to use for the operation
   * @param {boolean} [options.retryWrites] Enable retryable writes for this operation
   * @param {opResultCallback} callback A callback function
   */
  remove(ns, ops, options, callback) {
    callback(null, null);
  }

  /**
   * Execute a command
   *
   * @method
   * @param {string} ns The MongoDB fully qualified namespace (ex: db1.collection1)
   * @param {object} cmd The command hash
   * @param {ReadPreference} [options.readPreference] Specify read preference if command supports it
   * @param {Connection} [options.connection] Specify connection object to execute command against
   * @param {Boolean} [options.serializeFunctions=false] Specify if functions on an object should be serialized.
   * @param {Boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
   * @param {ClientSession} [options.session=null] Session to use for the operation
   * @param {opResultCallback} callback A callback function
   */
  command(ns, cmd, options, callback) {
    callback(null, null);
  }

  /**
   * Create a new cursor
   *
   * @method
   * @param {string} ns The MongoDB fully qualified namespace (ex: db1.collection1)
   * @param {object|Long} cmd Can be either a command returning a cursor or a cursorId
   * @param {object} [options] Options for the cursor
   * @param {object} [options.batchSize=0] Batchsize for the operation
   * @param {array} [options.documents=[]] Initial documents list for cursor
   * @param {ReadPreference} [options.readPreference] Specify read preference if command supports it
   * @param {Boolean} [options.serializeFunctions=false] Specify if functions on an object should be serialized.
   * @param {Boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
   * @param {ClientSession} [options.session=null] Session to use for the operation
   * @param {object} [options.topology] The internal topology of the created cursor
   * @returns {Cursor}
   */
  cursor(/* ns, cmd, options */) {
    //
  }
}

function topologyTypeFromSeedlist(seedlist, options) {
  if (seedlist.length === 1 && !options.replicaset) return TopologyType.Single;
  if (options.replicaset) return TopologyType.ReplicaSetNoPrimary;
  return TopologyType.Unknown;
}

function randomSelection(array) {
  return array[Math.floor(Math.random() * array.length)];
}

/**
 *
 * @param {*} topology
 * @param {*} selector
 * @param {*} options
 * @param {*} callback
 */
function selectServers(topology, selector, timeout, start, callback) {
  const serverDescriptions = Array.from(topology.description.servers.values());
  let descriptions;

  try {
    descriptions = selector
      ? selector(topology.description, serverDescriptions)
      : serverDescriptions;
  } catch (e) {
    return callback(e, null);
  }

  if (descriptions.length) {
    // TODO: obviously return the actual server in the future
    const servers = descriptions.map(d => new Server(d));
    return callback(null, servers);
  }

  const duration = calculateDurationInMs(process.hrtime(start));
  if (duration > timeout) {
    return callback(new MongoTimeoutError(`Server selection timed out after ${timeout} ms`));
  }

  // TODO: loop this, add monitoring
}

function connectServers(topology, servers) {
  const serverInstances = servers.reduce((servers, serverAddress) => {
    // publish an open event for each ServerDescription created
    topology.emit('serverOpening', new monitoring.ServerOpeningEvent(topology.s.id, serverAddress));

    const server = new Server();
    servers.set(serverAddress, server);
    server.connect();
    return servers;
  }, new Map());

  topology.s.servers = serverInstances;
}

function updateServers(topology) {
  // TODO: implement code to add NEW servers

  // for all servers no longer known, remove their descriptions and destroy their instances
  for (const entry of topology.s.servers) {
    const serverAddress = entry[0];
    if (topology.description.hasServer(serverAddress)) {
      continue;
    }

    const server = topology.s.servers.get(serverAddress);
    topology.s.servers.delete(serverAddress);

    server.destroy(() =>
      topology.emit('serverClosed', new monitoring.ServerClosedEvent(topology.s.id, serverAddress))
    );
  }
}

/**
 * A server opening SDAM monitoring event
 *
 * @event Topology#serverOpening
 * @type {ServerOpeningEvent}
 */

/**
 * A server closed SDAM monitoring event
 *
 * @event Topology#serverClosed
 * @type {ServerClosedEvent}
 */

/**
 * A server description SDAM change monitoring event
 *
 * @event Topology#serverDescriptionChanged
 * @type {ServerDescriptionChangedEvent}
 */

/**
 * A topology open SDAM event
 *
 * @event Topology#topologyOpening
 * @type {TopologyOpeningEvent}
 */

/**
 * A topology closed SDAM event
 *
 * @event Topology#topologyClosed
 * @type {TopologyClosedEvent}
 */

/**
 * A topology structure SDAM change event
 *
 * @event Topology#topologyDescriptionChanged
 * @type {TopologyDescriptionChangedEvent}
 */

/**
 * A topology serverHeartbeatStarted SDAM event
 *
 * @event Topology#serverHeartbeatStarted
 * @type {ServerHeartbeatStartedEvent}
 */

/**
 * A topology serverHeartbeatFailed SDAM event
 *
 * @event Topology#serverHeartbeatFailed
 * @type {ServerHearbeatFailedEvent}
 */

/**
 * A topology serverHeartbeatSucceeded SDAM change event
 *
 * @event Topology#serverHeartbeatSucceeded
 * @type {ServerHeartbeatSucceededEvent}
 */

module.exports = {
  Topology,
  ServerDescription
};
