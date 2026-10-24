# Alternative to the systemd install: run autodev in a container.
# Note: the agents' OS sandbox (bubblewrap) needs unprivileged user namespaces; run with
#   --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
#   --security-opt systempaths=unconfined
# systempaths=unconfined permits bubblewrap's private /proc mount in Docker.
# The OS sandbox is still mandatory; there is no unsandboxed fallback.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates bubblewrap socat build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 10001 autodev
RUN install -d -o autodev -g autodev /opt/autodev/instance /opt/autodev/instance-work
WORKDIR /opt/autodev/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY bin ./bin
USER autodev
VOLUME ["/opt/autodev/instance", "/opt/autodev/instance-work"]
WORKDIR /opt/autodev/instance
ENV AUTODEV_CONFIG=/opt/autodev/instance/autodev.config.yaml
CMD ["node", "/opt/autodev/app/src/cli.ts", "run"]
