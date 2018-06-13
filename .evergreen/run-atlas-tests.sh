#!/bin/sh

set -o errexit  # Exit the script with error if any of the commands fail

export PATH="/opt/mongodbtoolchain/v2/bin:$PATH"
NODE_ARTIFACTS_PATH="${PROJECT_DIRECTORY}/node-artifacts"
export NVM_DIR="${NODE_ARTIFACTS_PATH}/nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

ATLAS_REPL=$ATLAS_REPL ATLAS_SHRD=$ATLAS_SHRD ATLAS_FREE=$ATLAS_FREE npm run atlas