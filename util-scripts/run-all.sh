#!/bin/bash

# Usage (from the repository root): util-scripts/run-all.sh <lnd_repository> [line]
# Updates one LND line of lib/versions.js (default: the default line) from an LND checkout:
# copies its protos, regenerates its all-api.js and the TypeScript declarations.
# The checkout must be at the tag recorded for the line in lib/versions.js.

set -e

line=${2:-`node -p "require('./lib/versions').defaultVersion"`}
read proto_dir api tag <<< `node -p "
  const v = require('./lib/versions').versions['$line'];
  if (!v) { console.error('Add the line $line to lib/versions.js first'); process.exit(1); }
  ['lib/' + v.protoDir, 'lib/' + v.api, v.lndTag].join(' ')"`

actual=`git -C "$1" describe --tags --exact-match 2>/dev/null || true`
if [ "$actual" != "$tag" ]; then
  echo "$1 is at '${actual:-no tag}', but lib/versions.js expects $tag for the line $line" >&2
  exit 1
fi

./util-scripts/copy-proto-files.sh "$1" "$proto_dir"
./util-scripts/generate-all-api-object.sh "$proto_dir" "$api"
node util-scripts/generate-types.js
echo "Everything was done OK!"
