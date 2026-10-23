#!/usr/bin/env bash
# Link the host's Pi packages into ./node_modules for standalone tests.
#
# The extension runs *inside* Pi, where `@earendil-works/pi-coding-agent` and
# `typebox` resolve natively. Node's test runner has no such resolution, so the
# tests need these links. They are test-only; never install this directory as a
# package (the host suppresses peer installs and maps these modules itself).
set -euo pipefail
cd "$(dirname "$0")"

ROOT="${PI_MANAGED_INSTALL_ROOT:-${PI_AGENT_DIR:-$HOME/.pi/agent}/install}"
VERSION_FILE="$ROOT/current-version"
if [ -r "$VERSION_FILE" ]; then
	VERSION="$(cat "$VERSION_FILE")"
	HOST="$ROOT/releases/$VERSION/node_modules"
else
	HOST="${1:-}"
fi

if [ -z "${HOST:-}" ] || [ ! -d "$HOST/@earendil-works/pi-coding-agent" ]; then
	echo "Cannot find the host Pi packages." >&2
	echo "Pass them explicitly: $0 /path/to/node_modules" >&2
	exit 1
fi

mkdir -p node_modules/@earendil-works node_modules/@types
ln -sfn "$HOST/@earendil-works/pi-coding-agent" node_modules/@earendil-works/pi-coding-agent
ln -sfn "$HOST/typebox" node_modules/typebox
[ -d "$HOST/@types/node" ] && ln -sfn "$HOST/@types/node" node_modules/@types/node
echo "linked $HOST into ./node_modules"
