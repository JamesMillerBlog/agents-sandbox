#!/bin/sh
set -eu

PI_AUTH_SOURCE=/run/agents-sandbox/pi-auth.json
PI_AUTH_TARGET=/home/sandbox/.pi/agent/auth.json

# Seed persistent Pi state once. Subsequent OAuth refreshes stay in the
# writable state volume instead of being overwritten by the read-only source.
if [ -f "$PI_AUTH_SOURCE" ]; then
  mkdir -p "$(dirname "$PI_AUTH_TARGET")"
  if [ -L "$PI_AUTH_TARGET" ] || {
    [ -e "$PI_AUTH_TARGET" ] && [ ! -f "$PI_AUTH_TARGET" ];
  }; then
    echo "Pi auth target is not a regular file: $PI_AUTH_TARGET" >&2
    exit 1
  fi
  if [ ! -e "$PI_AUTH_TARGET" ]; then
    umask 077
    cp "$PI_AUTH_SOURCE" "$PI_AUTH_TARGET"
  fi
  chmod 600 "$PI_AUTH_TARGET"
fi

exec pi "$@"
