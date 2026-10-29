#!/bin/bash

# Usage: util-scripts/copy-proto-files.sh [lnd_repository] [target_dir]
# Copies the *.proto files of lnrpc/ (keeping the directory structure) into target_dir,
# removing protos that no longer exist in LND. Defaults: extra/lnd, lib/original-lnd-protos.

set -e

lnd_async_dir=`pwd`
lnd_repo=${1:-extra/lnd}
target=${2:-lib/original-lnd-protos}

case "$target" in
  lib/*protos) ;;
  *) echo "The target directory must be lib/...protos, got: $target" >&2; exit 1 ;;
esac

mkdir -p "$lnd_async_dir/$target"
cd "$lnd_repo/lnrpc"
rsync -azvm --delete --include='**.proto' --include='*/' --exclude='**' ./ "$lnd_async_dir/$target/"
echo "The proto files are copied"
