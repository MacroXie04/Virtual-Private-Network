# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# Keep the sing-box release and build tags stable while locking security fixes
# for its transitive dependencies in a separate build module.
FROM golang:1.27.1-alpine3.24@sha256:cf6fca6641884b8433441b2b0652976f975e1d0fdd26d177eaaf8596087f3125 AS sing-box-build

ENV GOPROXY=https://proxy.golang.org \
    GOSUMDB=sum.golang.org \
    GOTOOLCHAIN=local
WORKDIR /build
COPY deploy/docker/sing-box/go.mod deploy/docker/sing-box/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -mod=readonly \
      -trimpath \
      -tags "with_gvisor,with_utls,with_tailscale" \
      -ldflags "-s -w -buildid= -X github.com/sagernet/sing-box/constant.Version=1.13.21 -X internal/godebug.defaultGODEBUG=multipathtcp=0" \
      -o /out/sing-box github.com/sagernet/sing-box/cmd/sing-box \
    && go mod verify
RUN /out/sing-box version | grep -Fx "sing-box version 1.13.21" \
    && /out/sing-box version | grep -Fx "Tags: with_gvisor,with_utls,with_tailscale"

FROM node:26.8.1-alpine3.24@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3

ADD --checksum=sha256:9f58bff01604cb1b14008fef14dceb14d836a49225e45c6c2e37de3be3e707f0 \
  https://registry.npmjs.org/npm/-/npm-11.19.1.tgz /tmp/npm-11.19.1.tgz
RUN apk add --no-cache --upgrade libcrypto3=3.5.8-r0 libssl3=3.5.8-r0 \
    && npm install --global --offline --ignore-scripts --no-audit --no-fund \
      --update-notifier=false --cache /tmp/npm-cache /tmp/npm-11.19.1.tgz \
    && test "$(npm --version)" = 11.19.1 \
    && rm -rf /tmp/npm-cache /tmp/npm-11.19.1.tgz

RUN addgroup -S -g 11000 vpn-runtime \
    && adduser -S -D -H -h /nonexistent -s /sbin/nologin -u 11000 -G vpn-runtime vpn-runtime \
    && addgroup -S -g 11001 vpn-sub \
    && adduser -S -D -H -h /nonexistent -s /sbin/nologin -u 11001 -G vpn-sub vpn-sub \
    && addgroup -S -g 11002 vpn-admin \
    && adduser -S -D -H -h /nonexistent -s /sbin/nologin -u 11002 -G vpn-admin vpn-admin \
    && test -x /usr/bin/flock

COPY --from=sing-box-build /out/sing-box /usr/local/bin/sing-box

WORKDIR /app
COPY --chown=root:root --chmod=0644 package.json ./package.json
COPY --chown=root:root src/ ./src/
COPY --chown=root:root --chmod=0755 deploy/docker/entrypoint.sh ./entrypoint.sh

ENV NODE_ENV=production \
    DATA_DIR=/data \
    CONTROLLER_SOCKET=/run/vpn-gateway/controller.sock \
    SINGBOX_BIN=/usr/local/bin/sing-box \
    SINGBOX_CONFIG=/data/runtime/sing-box.json \
    SINGBOX_STATE_DIR=/data/tailscale \
    SUPERVISE=1 \
    NODE_HOST=127.0.0.1 \
    NODE_PORT=8443 \
    SUB_HOST=127.0.0.1 \
    SUB_PORT=8080 \
    ADMIN_HOST=127.0.0.1 \
    ADMIN_PORT=8081 \
    SINGBOX_UID=11000 \
    SINGBOX_GID=11000 \
    SUB_UID=11001 \
    SUB_GID=11001 \
    ADMIN_UID=11002 \
    ADMIN_GID=11002

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD ["node", "/app/src/runtime/healthcheck.js"]

USER root:root
ENTRYPOINT ["/app/entrypoint.sh"]
