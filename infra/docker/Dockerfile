# syntax=docker/dockerfile:1

# The one Bun pin. The tag is derived from the version and variant; the digest
# is the tag's multi-platform index. A deploy should refuse when the registry's
# digest for the derived tag differs (BuildKit does not check that pair), and a
# unit test keeps `@types/bun` in package.json equal to BUN_VERSION. To bump:
# `docker buildx imagetools inspect oven/bun:<version>-<variant>`, then update
# the ARGs together.
ARG BUN_VERSION=1.4.3
ARG BUN_VARIANT=alpine
ARG BUN_DIGEST=sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373

# The runtime account: the image's `bun` user. Every copied file belongs to it,
# so a build context written under a restrictive umask stays readable.
ARG RUNTIME_UID=1000
ARG RUNTIME_GID=1000

# Every stage uses the same pinned image, so native add-ons (sharp) are
# installed for the libc they run on. Alpine (musl) rather than distroless:
# distroless lacks libstdc++ and libgcc_s, which sharp and the Vite toolchain load.
FROM oven/bun:${BUN_VERSION}-${BUN_VARIANT}@${BUN_DIGEST} AS base
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY infra/docker/package.json infra/docker/

# The server's production dependencies. Bun's isolated linker keeps them in the
# root node_modules/.bun store, linked from each workspace's node_modules. Both
# installs share BuildKit's cache of Bun's package downloads.
FROM base AS deps
RUN --mount=type=cache,target=/root/.bun/install/cache \
  ["bun", "install", "--frozen-lockfile", "--production", "--filter", "@ephemera/server"]

# The SPA build.
FROM base AS web
RUN --mount=type=cache,target=/root/.bun/install/cache ["bun", "install", "--frozen-lockfile"]
COPY tsconfig.base.json ./
COPY packages/core/src packages/core/src
COPY packages/core/tsconfig.json packages/core/
COPY apps/server/src apps/server/src
COPY apps/web apps/web
# The deployed commit, which the bundle and the server both name (apps/server
# src/build.ts). Declared after the copies, so it rebuilds only the SPA.
ARG VCS_REF=unknown
ENV EPHEMERA_BUILD_REVISION=$VCS_REF
# The workspace's own build script, the one e2e tests: Bun runs Vite and loads
# its TypeScript config natively, so the image needs no Node.
RUN ["bun", "run", "build"]

FROM oven/bun:${BUN_VERSION}-${BUN_VARIANT}@${BUN_DIGEST} AS runtime
ARG RUNTIME_UID
ARG RUNTIME_GID
ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF
# No transpiler cache: the root filesystem is read-only and nothing else is written.
ENV NODE_ENV=production \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    EPHEMERA_BUILD_REVISION=$VCS_REF
WORKDIR /app
COPY --from=deps --chown=${RUNTIME_UID}:${RUNTIME_GID} /app/node_modules node_modules
COPY --from=deps --chown=${RUNTIME_UID}:${RUNTIME_GID} /app/apps/server/node_modules apps/server/node_modules
COPY --from=deps --chown=${RUNTIME_UID}:${RUNTIME_GID} /app/packages/core/node_modules packages/core/node_modules
COPY --chown=${RUNTIME_UID}:${RUNTIME_GID} package.json ./
COPY --chown=${RUNTIME_UID}:${RUNTIME_GID} apps/server/package.json apps/server/
COPY --chown=${RUNTIME_UID}:${RUNTIME_GID} packages/core/package.json packages/core/
# Sources without core's unit tests, which only the workspace runs.
COPY --chown=${RUNTIME_UID}:${RUNTIME_GID} --exclude=**/*.test.ts packages/core/src packages/core/src
COPY --chown=${RUNTIME_UID}:${RUNTIME_GID} apps/server/src apps/server/src
COPY --chown=${RUNTIME_UID}:${RUNTIME_GID} apps/server/drizzle apps/server/drizzle
COPY --from=web --chown=${RUNTIME_UID}:${RUNTIME_GID} /app/apps/web/dist apps/web/dist
COPY --chown=${RUNTIME_UID}:${RUNTIME_GID} infra/docker/healthcheck.ts infra/docker/
# The mount points of the data bind, the ComfyUI CA bind and the workflows
# bind, so the running container's diff stays empty.
RUN install -d -m 0700 -o "$RUNTIME_UID" -g "$RUNTIME_GID" /data \
  && install -d -m 0755 /run /run/workflows && touch /run/comfyui-ca.pem
USER ${RUNTIME_UID}:${RUNTIME_GID}
EXPOSE 8790
# The same entry e2e runs against the same built SPA.
ENTRYPOINT ["bun", "apps/server/src/index.ts"]
