FROM docker.io/cloudflare/sandbox:0.7.0

# Install Node.js 22 (required by openclaw)
# The base image has Node 20, we need to replace it with Node 22
# Using direct binary download for reliability
ENV NODE_VERSION=22.13.1
RUN ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
         amd64) NODE_ARCH="x64" ;; \
         arm64) NODE_ARCH="arm64" ;; \
         *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
       esac \
    && apt-get update && apt-get install -y xz-utils ca-certificates \
    && curl -fsSLk https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version \
    && npm --version

# Install pnpm globally
RUN npm install -g pnpm

# Copy pre-built openclaw tarball from local build
COPY openclaw-2026.2.4.tgz /tmp/
RUN npm install -g /tmp/openclaw-2026.2.4.tgz \
    && openclaw --version \
    && rm /tmp/openclaw-2026.2.4.tgz

# Patch openclaw to fix CaptainApp provider API key resolution
# Native resolveEnvApiKeyVarName returns var NAME not VALUE — this patch overrides it
COPY captainapp-provider.patch.js /tmp/captainapp-provider.patch.js
RUN node /tmp/captainapp-provider.patch.js && rm /tmp/captainapp-provider.patch.js

# Symlink openclaw docs/templates to /workspace/ (sandbox CWD)
# openclaw resolves templates relative to CWD, which sandbox sets to /workspace/
RUN mkdir -p /workspace \
    && ln -sfn /usr/local/lib/node_modules/@captain-app/openclaw/docs /workspace/docs

# Create openclaw directories
# Templates are stored in /root/.openclaw-templates for initialization
RUN mkdir -p /root/.openclaw \
    && mkdir -p /root/.openclaw-templates \
    && mkdir -p /root/openclaw \
    && mkdir -p /root/openclaw/skills

# Copy startup script
ARG BUILD_VERSION=v22
COPY start-moltbot.sh /usr/local/bin/start-moltbot.sh
RUN chmod +x /usr/local/bin/start-moltbot.sh

# Copy default configuration template
# Cache bust: 2026-02-05-v14 - Force template update with Telegram config
COPY moltbot.json.template /root/.openclaw-templates/moltbot.json.template
RUN cat /root/.openclaw-templates/moltbot.json.template | head -5

# Copy custom skills
COPY skills/ /root/openclaw/skills/

# Set working directory
WORKDIR /root/openclaw

# Expose the gateway port
EXPOSE 18789
RUN echo "build-2026-02-06-v4-captainapp-patch" > /tmp/.build-version
