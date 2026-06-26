#!/bin/zsh
set -euo pipefail

RUNTIME_DIR="/Users/matiasmassetti/.fifa-hospitality-monitor"

mkdir -p "$RUNTIME_DIR/src"
mkdir -p "$RUNTIME_DIR/assets"

cp package.json .env .env.example "$RUNTIME_DIR/"
cp src/config.js src/dashboard.js src/fifaHospitality.js src/monitor.js src/telegram.js src/telegramTest.js "$RUNTIME_DIR/src/"
cp assets/la-banda-argentina.jpg "$RUNTIME_DIR/assets/"

echo "Runtime synced to $RUNTIME_DIR"
