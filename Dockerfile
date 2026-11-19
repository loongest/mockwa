# syntax=docker/dockerfile:1

# mockwa (a fork of whaloc) ships as a single image with two listeners (SPEC §8): the Graph API
# mock on 8888, and the control plane (+ WebSocket) with the static web UI on 8025.

ARG NODE_IMAGE=node:24-alpine

# --- build ---------------------------------------------------------------------------------
# Compiles shared + server with `tsc` and the UI with Vite. Nothing from this stage reaches the
# image except the three `dist` directories.
FROM ${NODE_IMAGE} AS build

ENV CI=true

WORKDIR /src

# npm ships with Node, so there is nothing to bootstrap. The manifests and the lockfile are
# copied on their own: the install layer is then only invalidated by a dependency change, not
# by every source edit.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

RUN --mount=type=cache,id=npm,target=/root/.npm,sharing=locked \
	npm ci

COPY tsconfig.base.json ./
COPY packages packages
# The console bundles the shipped example scenarios (Scenarios view), read at build time.
COPY examples/scenarios examples/scenarios

# `shared` first: the server and the UI both compile against its emitted declarations. npm runs
# workspace scripts in manifest order rather than topologically, which is why the root `build`
# script names the three explicitly instead of relying on `--workspaces`.
RUN npm run build

# --- production dependencies ---------------------------------------------------------------
# A self-contained production tree: a second `npm ci` from the very same lockfile, this time
# without dev dependencies and scoped to the server's workspace. The scope is what keeps
# the UI's runtime dependencies — React & co., which the server never loads — out of the image;
# an unscoped `--omit=dev` install would drag in ~11 MB of them. `packages/web/package.json` is
# deliberately not copied here: the UI's dependencies cannot change this layer.
FROM ${NODE_IMAGE} AS deps

ENV CI=true

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/

RUN --mount=type=cache,id=npm,target=/root/.npm,sharing=locked \
	npm ci --omit=dev --workspace @mockwa/server --include-workspace-root

# --- runtime -------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="mockwa" \
	org.opencontainers.image.description="WhatsApp Cloud API simulator (Graph API v25.0), a fork of whaloc" \
	org.opencontainers.image.source="https://github.com/loongest/mockwa" \
	org.opencontainers.image.licenses="MIT"

# The image keeps the repository's own layout, so the web bundle lands exactly where the server
# looks for it by default (`packages/web/dist`, beside the server) and `MOCKWA_WEB_DIR` needs no
# value here.
ENV NODE_ENV=production \
	MOCKWA_MEDIA_DIR=/data/media

WORKDIR /app

# The production `node_modules` carries `@mockwa/shared` as a symlink into `packages/shared`, so
# the manifests it resolves through travel with it — `exports` there is what points the server's
# `dist` at the shared `dist`.
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json ./
COPY --from=deps /app/packages/shared/package.json packages/shared/
COPY --from=deps /app/packages/server/package.json packages/server/

COPY --from=build /src/packages/shared/dist packages/shared/dist
COPY --from=build /src/packages/server/dist packages/server/dist
COPY --from=build /src/packages/web/dist packages/web/dist

# The application tree stays root-owned and read-only to the runtime user; only `/data` is
# writable. Creating it here (before `VOLUME`) is what gives a fresh named or anonymous volume
# the right ownership — a bind mount keeps the host's, so its directory has to be writable by
# uid 1000 (the `node` user) on the host side.
RUN mkdir -p /data/media && chown -R node:node /data

# `mockwa scenario run|validate` (SPEC §4, "Scenarios") inside the container, for
# `docker exec <container> mockwa scenario run /scenarios/x.json --url http://127.0.0.1:8025`.
RUN printf '#!/bin/sh\nexec node --disable-warning=ExperimentalWarning /app/packages/server/dist/cli/mockwa.js "$@"\n' \
	> /usr/local/bin/mockwa && chmod 755 /usr/local/bin/mockwa

USER node

# 8888: the Graph API the app under test calls. 8025: the console (UI, /api, /api/ws). Publish
# them to loopback (`-p 127.0.0.1:8888:8888`) unless the network is trusted: dev mode has no login.
EXPOSE 8888 8025
VOLUME /data

# busybox `wget` is already in the image, so the probe costs no extra layer and no Node boot.
# Both listeners must answer: one of them down is an unhealthy container. The legacy
# `WHALOC_PORT` still moves the Graph listener (SPEC §7), so the probe follows it too.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
	CMD wget -q --spider -T 3 "http://127.0.0.1:${MOCKWA_GRAPH_PORT:-${WHALOC_PORT:-8888}}/health" \
	&& wget -q --spider -T 3 "http://127.0.0.1:${MOCKWA_CONSOLE_PORT:-8025}/health" || exit 1

# The release tag, handed in by the publish workflow; last, so a new version rebuilds no layer.
ARG MOCKWA_VERSION=0.0.0-dev
ENV MOCKWA_VERSION=${MOCKWA_VERSION}

# `node:sqlite` is still flagged experimental in Node 24 and warns on first use; the emulator
# does not need the reminder on every boot.
CMD ["node", "--disable-warning=ExperimentalWarning", "packages/server/dist/main.js"]
