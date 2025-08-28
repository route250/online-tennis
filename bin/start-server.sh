#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: bin/start-server.sh [--port PORT|-p PORT]

Starts the authoritative game server (Express + ws) and serves the client from ./client.

Options:
  -p, --port PORT   Port to listen on (default: 3000 or $PORT)

Examples:
  bin/start-server.sh
  bin/start-server.sh -p 4000
  PORT=8080 bin/start-server.sh
USAGE
}

PORT_ARG="${PORT:-3000}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port)
      [[ $# -lt 2 ]] && { echo "Error: --port requires a value" >&2; usage; exit 2; }
      PORT_ARG="$2"; shift 2;;
    -h|--help)
      usage; exit 0;;
    *)
      echo "Unknown argument: $1" >&2; usage; exit 2;;
  esac
done

# Resolve project root (one level up from this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

# Basic sanity checks
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is not installed or not in PATH." >&2
  exit 1
fi

if [[ ! -f server/index.js ]]; then
  echo "Error: server/index.js not found. Are you in the repo root?" >&2
  exit 1
fi

# Check required dependencies are installed
if ! node -e "require('express'); require('ws');" >/dev/null 2>&1; then
  echo "Error: dependencies missing. Run: npm install" >&2
  exit 1
fi

echo "==> Starting server"
echo "    - Port: $PORT_ARG"
echo "    - WS:   ws://<host>:$PORT_ARG/ws"
echo "    - App:  http://localhost:$PORT_ARG"
echo

PORT="$PORT_ARG" node server/index.js

