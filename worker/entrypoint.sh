#!/bin/sh
set -eu
: "${BURROWSER_VNC_PASSWORD:?BURROWSER_VNC_PASSWORD is required}"
Xvfb "${DISPLAY:-:99}" -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
xvfb_pid=$!
sleep 0.5
x11vnc -display "${DISPLAY:-:99}" -rfbport 5900 -passwd "$BURROWSER_VNC_PASSWORD" -viewonly -shared -forever -noxdamage -quiet >/tmp/x11vnc.log 2>&1 &
vnc_pid=$!
trap 'kill "$xvfb_pid" "$vnc_pid" 2>/dev/null || true' TERM INT EXIT
exec node --experimental-strip-types src/main.ts
