#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi
if ! node --version 2>/dev/null | grep -q '^v1[89]\.\|^v2[0-9]\.'; then
  echo "Need Node 18+. Install nvm (https://github.com/nvm-sh/nvm) then: nvm install 20"
  exit 1
fi
cd "$ROOT/capability-registry"
npm run build
cd "$ROOT/draft-test-harness"
npm install
exec npm start
