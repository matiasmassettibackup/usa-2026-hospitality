#!/bin/zsh
set -euo pipefail

cd /Users/matiasmassetti/Desktop/Personal/Repos/bot-hospitality-2026

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p .state

exec /opt/homebrew/bin/npm run watch
