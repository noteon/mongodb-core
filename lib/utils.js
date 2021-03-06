'use strict';

const crypto = require('crypto');

/**
 * Generate a UUIDv4
 */
const uuidV4 = () => {
  const result = crypto.randomBytes(16);
  result[6] = (result[6] & 0x0f) | 0x40;
  result[8] = (result[8] & 0x3f) | 0x80;
  return result;
};

/**
 * Returns the duration calculated from two high resolution timers in milliseconds
 *
 * @param {Object} started A high resolution timestamp created from `process.hrtime()`
 * @returns {Number} The duration in milliseconds
 */
const calculateDurationInMs = started => {
  const hrtime = process.hrtime(started);
  return (hrtime[0] * 1e9 + hrtime[1]) / 1e6;
};

module.exports = {
  uuidV4,
  calculateDurationInMs
};
