# TaskLatch agent desktop: one disposable Linux desktop per agent.
# Xvfb (virtual screen) + Fluxbox + Chromium, streamed with x11vnc/noVNC, controlled through desktopd.
# No terminal, no file manager, downloads and devtools disabled, proxy fixed by managed browser policy.
FROM debian:bookworm-slim

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb fluxbox x11vnc novnc websockify chromium xdotool scrot python3 \
      fonts-dejavu-core fonts-liberation ca-certificates procps \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /usr/sbin/nologin agent

# Managed Chromium policy: traffic must go through the TaskLatch proxy; users/agents cannot change it.
COPY chromium-policy.json /etc/chromium/policies/managed/tasklatch.json
COPY fluxbox/ /home/agent/.fluxbox/
COPY desktopd.py start.sh /opt/tasklatch/
RUN chmod 0755 /opt/tasklatch/start.sh && chown -R agent:agent /home/agent

USER agent
ENV DISPLAY=:1 HOME=/home/agent
EXPOSE 6080 8000
ENTRYPOINT ["/opt/tasklatch/start.sh"]
