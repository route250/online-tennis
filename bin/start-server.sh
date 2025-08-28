#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: bin/server.sh [--port PORT|-p PORT] [--host HOST|-H HOST] [--local|--public]

Starts the authoritative game server (Express + ws), serving client from ./client.

Options:
  -p, --port PORT   Port to listen on (default: 3000 or $PORT)
  -H, --host HOST   Host to bind (localhost or 0.0.0.0). Default: 0.0.0.0
      --local       Shortcut for --host localhost
      --public      Shortcut for --host 0.0.0.0
  -h, --help        Show this help

Examples:
  bin/server.sh                 # bind 0.0.0.0:3000
  bin/server.sh -p 4000         # bind 0.0.0.0:4000
  bin/server.sh --local         # bind localhost:3000
  bin/server.sh -p 8080 -H localhost
USAGE
}

PORT_ARG="${PORT:-3000}"
HOST_ARG="${HOST:-0.0.0.0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port)
      [[ $# -lt 2 ]] && { echo "Error: --port requires a value" >&2; usage; exit 2; }
      PORT_ARG="$2"; shift 2;;
    -H|--host)
      [[ $# -lt 2 ]] && { echo "Error: --host requires a value" >&2; usage; exit 2; }
      HOST_ARG="$2"; shift 2;;
    --local)
      HOST_ARG="localhost"; shift;;
    --public)
      HOST_ARG="0.0.0.0"; shift;;
    -h|--help)
      usage; exit 0;;
    *)
      echo "Unknown argument: $1" >&2; usage; exit 2;;
  esac
done

# Validate host
case "$HOST_ARG" in
  localhost|0.0.0.0) :;;
  *) echo "Error: --host must be 'localhost' or '0.0.0.0'" >&2; exit 2;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is not installed or not in PATH." >&2
  exit 1
fi

if [[ ! -f server/index.js ]]; then
  echo "Error: server/index.js not found. Are you in the repo root?" >&2
  exit 1
fi

if ! node -e "require('express'); require('ws');" >/dev/null 2>&1; then
  echo "Error: dependencies missing. Run: npm install" >&2
  exit 1
fi

echo "==> Starting server"
echo "    - Host: $HOST_ARG"
echo "    - Port: $PORT_ARG"
echo "    - WS:   ws://$HOST_ARG:$PORT_ARG/ws"
echo "    - App:  http://$HOST_ARG:$PORT_ARG"
echo

HOST="$HOST_ARG" PORT="$PORT_ARG" node server/index.js

