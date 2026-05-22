# ── Stage 1: Build Jamini Bridge ─────────────────────────────────────
FROM node:22-bookworm-slim AS bridge-builder
WORKDIR /app
COPY bridge/package*.json ./
RUN npm install --no-audit --no-fund
COPY bridge/tsconfig.json ./
COPY bridge/src ./src
RUN npx tsc

# ── Stage 2: Build Jamini CLI ───────────────────────────────────────
FROM node:22-bookworm-slim AS cli-builder
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ── Stage 3: Final Image ────────────────────────────────────────────
FROM node:22-bookworm-slim

# Install runtime deps only — keep it minimal
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

# Directories
WORKDIR /opt/jamini
RUN mkdir -p bin bridge config /workspace /home/jamini/.jamini

# Install official Gemini CLI (global npm)
ARG GEMINI_CLI_NPM_VERSION=0.42.0
RUN npm install -g @google/gemini-cli@${GEMINI_CLI_NPM_VERSION}

# Copy Jamini CLI
COPY --from=cli-builder /app/dist /opt/jamini/dist
COPY --from=cli-builder /app/node_modules /opt/jamini/node_modules
COPY --from=cli-builder /app/package.json /opt/jamini/package.json

# Copy Jamini Bridge
COPY --from=bridge-builder /app/dist /opt/jamini/bridge/dist
COPY --from=bridge-builder /app/package.json /opt/jamini/bridge/package.json
COPY --from=bridge-builder /app/node_modules /opt/jamini/bridge/node_modules

# Copy shell wrappers and config
COPY bin/ /opt/jamini/bin/
COPY config/ /opt/jamini/config/
RUN chmod +x /opt/jamini/bin/*

# Set up non-root jamini user
RUN groupadd -g 10001 jamini \
    && useradd -u 10001 --gid jamini --create-home --shell /bin/bash jamini \
    && chown -R jamini:jamini /workspace /home/jamini /opt/jamini

# Environment — bridge will pick an ephemeral port, JAMINI_BRIDGE_PORT only as fallback
ENV PATH="/opt/jamini/bin:${PATH}" \
    TERM="xterm-256color" \
    COLORTERM="truecolor" \
    HOME="/home/jamini" \
    JAMINI_HOME="/home/jamini/.jamini" \
    JAMINI_BRIDGE_MODE="process" \
    JAMINI_TRANSLATOR_MODE="custom" \
    JAMINI_BRIDGE_HOST="127.0.0.1" \
    JAMINI_GEMINI_HOME="/home/jamini/.jamini/gemini-cli-home" \
    JAMINI_WORKDIR="/workspace" \
    JAMINI_MODEL="v4-flash-thinking" \
    JAMINI_REASONING_EFFORT="high"

USER jamini
WORKDIR /workspace

ENTRYPOINT ["node", "/opt/jamini/dist/cli.js"]
CMD []

