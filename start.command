#!/bin/bash
# Cworks Drawing Translator — double-click to start. Leave this window open; close it to stop.
cd "$(dirname "$0")"
if [ ! -x .venv/bin/dxft ]; then
  echo "Setting up (first run only)…"; python3 -m venv .venv && .venv/bin/pip install -q -e . || { echo "Setup failed"; read -n1; exit 1; }
fi
echo "Cworks Drawing Translator → http://127.0.0.1:8765   (close this window to stop)"
sleep 1; open "http://127.0.0.1:8765"
exec .venv/bin/dxft --jobs jobs serve --port 8765
