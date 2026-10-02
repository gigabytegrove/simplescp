#!/bin/sh
set -eu

UPDATED="/data/update/simplescp"

if [ -x "$UPDATED" ]; then
  exec "$UPDATED"
fi

exec /app/simplescp
