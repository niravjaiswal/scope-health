# Builds the reference agent from the source in this directory.
#
#   docker build -t my-agent reference-agent
#
# Everything the agent needs at run time is installed here: the Node packages of
# pnpm-lock.yaml, OpenCode, and Chromium. The build needs internet access. The container of a
# shift has none, so nothing may be downloaded after the build. To add a package or a tool,
# install it in this file.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim
FROM ${NODE_IMAGE}

ENV PNPM_VERSION=10.24.0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CI=1

# The shell tool gets a small set of common command line tools.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl jq python3 procps ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "pnpm@${PNPM_VERSION}"

WORKDIR /app

# Node dependencies come from the lockfile. contracts/ is a package of this workspace.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY contracts/package.json contracts/package.json
RUN pnpm install --frozen-lockfile --prod

# OpenCode ships as one binary per platform. The platform packages are optional dependencies,
# so pnpm installs only the one for this platform. Put it on the PATH.
RUN set -eu; \
    case "$(uname -m)" in \
      x86_64) arch=x64 ;; \
      aarch64) arch=arm64 ;; \
      *) echo "unsupported architecture $(uname -m)"; exit 1 ;; \
    esac; \
    ln -s "/app/node_modules/opencode-linux-${arch}/bin/opencode" /usr/local/bin/opencode; \
    opencode --version

# Chromium and its system libraries, installed by the Playwright version that Playwright MCP
# uses. Playwright MCP launches the full Chromium build in headless mode.
RUN set -eu; \
    mcp_dir="$(dirname "$(readlink -f /app/node_modules/@playwright/mcp/package.json)")"; \
    core_dir="$(dirname "$(dirname "$mcp_dir")")/playwright-core"; \
    node "$core_dir/cli.js" install --with-deps chromium; \
    rm -rf /var/lib/apt/lists/*; \
    chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"

COPY contracts contracts
COPY src src
COPY tsconfig.json tsconfig.json

RUN useradd --create-home --uid 10001 --shell /bin/bash agent \
 && mkdir -p /work \
 && chown agent:agent /work

USER agent
ENV HOME=/home/agent \
    WORK_DIR=/work \
    REFERENCE_PLAYWRIGHT_MCP=/app/node_modules/@playwright/mcp/cli.js \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_MODELS_FETCH=1 \
    OPENCODE_DISABLE_LSP_DOWNLOAD=1 \
    OPENCODE_DISABLE_DEFAULT_PLUGINS=1 \
    OPENCODE_DISABLE_SHARE=1 \
    OPENCODE_DISABLE_CLAUDE_CODE=1

CMD ["node", "--import", "tsx", "src/shiftMain.ts"]
