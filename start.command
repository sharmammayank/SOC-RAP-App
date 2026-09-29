#!/bin/bash
# Double-click to start SOC-RAP on macOS. Keep this window open while you use the app.
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
  python3 server.py
else
  echo "Python 3 is needed to run the local server."
  echo "Install it from https://www.python.org/downloads/ (or run: xcode-select --install), then double-click start.command again."
  read -r -p "Press Enter to close."
fi
