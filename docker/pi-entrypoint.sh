#!/bin/sh
set -eu

PI_AUTH_SOURCE=/run/agents-sandbox/pi-auth.json
PI_AUTH_TARGET=/home/sandbox/.pi/agent/auth.json
PI_AUTH_MARKER=/home/sandbox/.pi/agent/.agents-sandbox-pi-auth-bootstrap

# Seed persistent Pi state once. Subsequent OAuth refreshes stay in the
# writable state volume instead of being overwritten by the read-only source.
# The marker also migrates volumes containing Pi's pre-bootstrap empty auth
# placeholder without inspecting or logging credential contents.
if [ -f "$PI_AUTH_SOURCE" ]; then
  mkdir -p "$(dirname "$PI_AUTH_TARGET")"
  if [ -L "$PI_AUTH_TARGET" ] || {
    [ -e "$PI_AUTH_TARGET" ] && [ ! -f "$PI_AUTH_TARGET" ];
  }; then
    echo "Pi auth target is not a regular file: $PI_AUTH_TARGET" >&2
    exit 1
  fi
  if [ ! -e "$PI_AUTH_MARKER" ]; then
    umask 077
    cp "$PI_AUTH_SOURCE" "$PI_AUTH_TARGET"
    touch "$PI_AUTH_MARKER"
  fi
  chmod 600 "$PI_AUTH_TARGET" "$PI_AUTH_MARKER"
fi

exec pi "$@"
