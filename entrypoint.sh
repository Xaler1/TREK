#!/bin/sh
set -e

# Persistent volume mount point (override via DATA_DIR env var)
VOLUME="${DATA_DIR:-/mnt/data}"

# Create subdirectories on the persistent volume
mkdir -p "$VOLUME/data" \
         "$VOLUME/uploads/files" \
         "$VOLUME/uploads/covers" \
         "$VOLUME/uploads/avatars" \
         "$VOLUME/uploads/photos"

# Symlink app paths to persistent volume
ln -sfn "$VOLUME/data"    /app/data
ln -sfn "$VOLUME/uploads" /app/uploads

# Backwards-compat symlinks (old docker-compose paths)
ln -sfn /app/uploads /app/server/uploads
ln -sfn /app/data    /app/server/data

exec "$@"
