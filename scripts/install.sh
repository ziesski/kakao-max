#!/usr/bin/env bash
# Self-hosted install and repair on your own Linux server. `npm run setup` runs this for you.
#
#   sudo scripts/install.sh bootstrap [--port <port>]   first install (interactive)
#   sudo scripts/install.sh repair                      fix login details of a stopped managed install
#
# Both need a human terminal and a clean checkout of origin/main. Neither registers a new device
# without your phone approval, forces a login, or takes over another PC session.
set -euo pipefail

cmd=${1:-}
[ "$(id -u)" -eq 0 ] && [ -t 0 ] && [ -t 2 ] || { echo 'Run with sudo from a human terminal' >&2; exit 2; }
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "$cmd" in
  bootstrap)
    { [ "$#" -eq 1 ] || { [ "$#" -eq 3 ] && [ "$2" = --port ]; }; } || { echo 'usage: scripts/install.sh bootstrap [--port <port>]' >&2; exit 2; }
    exec node --experimental-strip-types apps/mcp/src/setup-system.ts --via-deploy 'self-hosted MCP first install' "${@:2}"
    ;;
  repair)
    [ "$#" -eq 1 ] || { echo 'usage: scripts/install.sh repair' >&2; exit 2; }
    target=$(git rev-parse origin/main)
    [ "$(git rev-parse HEAD)" = "$target" ] && [ -z "$(git status --porcelain)" ] || { echo 'Use a clean checkout of origin/main before repair' >&2; exit 1; }
    exec node --experimental-strip-types apps/mcp/src/update-managed.ts --via-deploy "$target" 'interactive managed authentication repair' --repair
    ;;
  *)
    echo 'usage: scripts/install.sh bootstrap [--port <port>] | repair' >&2; exit 2
    ;;
esac
