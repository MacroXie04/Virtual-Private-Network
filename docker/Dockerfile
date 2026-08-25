# syntax=docker/dockerfile:1

# 阶段一：从源码构建 sing-box。
# 官方 release 二进制不含 with_tailscale build tag（tailscale outbound 不可用），
# 且是 glibc 动态链接；此处用 CGO_ENABLED=0 编成静态二进制，运行时可用 alpine。
FROM golang:1.25-alpine AS singbox
ARG SINGBOX_VERSION=1.13.19
ARG BUILD_TAGS=with_gvisor,with_quic,with_dhcp,with_wireguard,with_utls,with_clash_api,with_tailscale
RUN CGO_ENABLED=0 go install -trimpath -ldflags "-s -w" -tags "$BUILD_TAGS" \
    "github.com/sagernet/sing-box/cmd/sing-box@v${SINGBOX_VERSION}"

# 阶段二：运行时（Node 订阅服务 + sing-box）
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

# /data：tsnet 状态、首次启动生成的凭据（env）、渲染后的 sing-box 配置、日志
VOLUME /data
EXPOSE 443/tcp 8080/tcp

ENTRYPOINT ["/app/entrypoint.sh"]
