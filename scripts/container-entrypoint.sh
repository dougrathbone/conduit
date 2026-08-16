#!/bin/sh
# Mode-aware container entrypoint. The same image runs as orchestrator or
# worker based on CONDUIT_PROCESS_MODE (default: server). Invalid values
# fail closed so a typo cannot silently start the wrong process.
set -eu

raw=${CONDUIT_PROCESS_MODE:-}
mode=$(printf '%s' "$raw" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')

if [ -z "$mode" ]; then
  mode=server
fi

case "$mode" in
  server)
    exec node out/server/index.js "$@"
    ;;
  worker)
    exec node out/worker/index.js "$@"
    ;;
  *)
    echo "CONDUIT_PROCESS_MODE must be 'server' or 'worker' (got: ${raw})" >&2
    exit 1
    ;;
esac
