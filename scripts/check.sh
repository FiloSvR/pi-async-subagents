#!/usr/bin/env bash
# Typecheck the extension and run the offline suite against the host pi.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "${PI_HOST_NODE_MODULES:-}" ]; then
	./setup-node-modules.sh "$PI_HOST_NODE_MODULES"
else
	./setup-node-modules.sh
fi

npm run typecheck
node --test --test-timeout=30000 test/*.test.ts
