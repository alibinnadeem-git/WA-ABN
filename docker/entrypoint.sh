#!/bin/sh
# Railway-managed volumes are mounted root-owned, after Docker image layers.
# Fix only the dedicated private app volume, then run the worker as unprivileged node.
set -eu
if [ ! -d /data ]; then
  echo "Podium CRM: required persistent /data directory is missing" >&2
  exit 1
fi
if [ "$(id -u)" -eq 0 ]; then
  chown -R node:node /data
  exec gosu node "$@"
fi
# Docker Compose/local operators may explicitly start as node.
if [ ! -w /data ]; then
  echo "Podium CRM: /data must be writable to preserve WhatsApp auth and review queue" >&2
  exit 1
fi
exec "$@"
