# syntax=docker/dockerfile:1

# Stage 1: build sing-box from source.
# The official release binaries are built without the with_tailscale build tag
# (tailscale outbound unavailable) and are dynamically linked against glibc;
# here we build a static binary with CGO_ENABLED=0 so the runtime can use alpine.
FROM golang:1.25-alpine AS singbox
ARG SINGBOX_VERSION=1.13.19
ARG BUILD_TAGS=with_gvisor,with_quic,with_dhcp,with_wireguard,with_utls,with_clash_api,with_tailscale
RUN CGO_ENABLED=0 go install -trimpath -ldflags "-s -w" -tags "$BUILD_TAGS" \
    "github.com/sagernet/sing-box/cmd/sing-box@v${SINGBOX_VERSION}"

# Stage 2: runtime (Node subscription service + sing-box)
FROM node:24-alpine
COPY --from=singbox /go/bin/sing-box /usr/local/bin/sing-box

WORKDIR /app
COPY sub/ ./
COPY server/config.template.json ./config.template.json
COPY docker/entrypoint.sh docker/ts-ctl.sh ./
RUN chmod +x /app/entrypoint.sh /app/ts-ctl.sh

ENV LISTEN_PORT=8080 \
    NODE_PORT=443 \
    SINGBOX_CONFIG=/data/config.json \
    SINGBOX_LOG=/data/sing-box.log \
    TS_CTL=/app/ts-ctl.sh

# /data: tsnet state, credentials generated on first start (env), rendered sing-box config, logs
VOLUME /data
EXPOSE 443/tcp 8080/tcp

ENTRYPOINT ["/app/entrypoint.sh"]
