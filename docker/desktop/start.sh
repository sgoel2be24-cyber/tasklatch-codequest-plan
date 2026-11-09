#!/bin/sh
# Starts the agent desktop. Required env: TL_DESKTOP_TOKEN (control API), TL_VNC_PASSWORD (live view).
set -e
: "${TL_DESKTOP_TOKEN:?missing}" "${TL_VNC_PASSWORD:?missing}"
W=${TL_SCREEN_W:-1280}; H=${TL_SCREEN_H:-800}

Xvfb :1 -screen 0 "${W}x${H}x24" -nolisten tcp >/tmp/xvfb.log 2>&1 &
for i in $(seq 1 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.1; done
fluxbox >/tmp/fluxbox.log 2>&1 &

# Chromium: own profile per container; the container is the sandbox (no setuid sandbox inside).
# All traffic goes through this desktop's own TaskLatch proxy port (identifies the agent). Loopback too.
# Remote debugging listens only inside the container; desktopd uses it to read the current URL and page text.
chromium --no-sandbox --test-type --no-first-run --no-default-browser-check --disable-dev-shm-usage --disable-gpu \
  --proxy-server="http://host.docker.internal:${TL_PROXY_PORT:?missing}" --proxy-bypass-list="<-loopback>" \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --remote-allow-origins=http://127.0.0.1:9222 \
  --password-store=basic --user-data-dir=/home/agent/profile --window-position=0,0 --window-size="${W},${H}" \
  --start-maximized "${TL_START_URL:-about:blank}" >/tmp/chromium.log 2>&1 &

mkdir -p /home/agent/.vnc && x11vnc -storepasswd "$TL_VNC_PASSWORD" /home/agent/.vnc/passwd >/dev/null 2>&1
x11vnc -display :1 -rfbauth /home/agent/.vnc/passwd -forever -shared -localhost -rfbport 5900 -quiet >/tmp/x11vnc.log 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &

exec python3 /opt/tasklatch/desktopd.py
