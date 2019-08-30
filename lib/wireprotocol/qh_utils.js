//add by qinghai
function qh_decorateShellSessionAndTransaction(cmd, shellCmds){
    //added by qinghai
    //transaction && session related
    if (typeof shellCmds.lsid !== 'undefined'){
      cmd.lsid=shellCmds.lsid;
    }
  
    if (typeof shellCmds.txnNumber !== 'undefined'){
      cmd.txnNumber=shellCmds.txnNumber;
    }
  
    if (typeof shellCmds.txnNumber !== 'undefined'){
      cmd.txnNumber=shellCmds.txnNumber;
    }
    
    if (typeof shellCmds.$clusterTime !== 'undefined'){
      cmd.$clusterTime=shellCmds.$clusterTime;
    }
  
    if (typeof shellCmds.autocommit !== 'undefined'){
      cmd.autocommit=shellCmds.autocommit;
    }
  
    if (typeof shellCmds.stmtId !== 'undefined'){
      cmd.stmtId=shellCmds.stmtId;
    }
  
    if (typeof shellCmds.startTransaction !== 'undefined'){
      cmd.startTransaction=shellCmds.startTransaction;
    }
  
  }
  
  module.exports = {
    qh_decorateShellSessionAndTransaction,
  }    