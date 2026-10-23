# Alternative to the systemd install: run autodev in a container.
# Note: the agents' OS sandbox (bubblewrap) needs unprivileged user namespaces; run with
#   --security-opt seccomp=unconfined --security-opt apparmor=unconfined
# or set sandbox.failIfUnavailable=false and rely on the container boundary instead.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates bubblewrap socat build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 10001 autodev
WORKDIR /opt/autodev/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY bin ./bin
USER autodev
VOLUME ["/opt/autodev/instance"]
WORKDIR /opt/autodev/instance
ENV AUTODEV_CONFIG=/opt/autodev/instance/autodev.config.yaml
CMD ["node", "/opt/autodev/app/src/cli.ts", "run"]
