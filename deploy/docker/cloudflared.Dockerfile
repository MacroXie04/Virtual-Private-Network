# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM golang:1.27.1-alpine3.24@sha256:cf6fca6641884b8433441b2b0652976f975e1d0fdd26d177eaaf8596087f3125 AS launcher-build

ARG TARGETOS
ARG TARGETARCH
WORKDIR /build
COPY deploy/docker/cloudflared-guard.go ./cloudflared-guard.go
RUN test "$TARGETOS" = linux \
    && CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
      go build -trimpath -ldflags "-s -w -buildid=" \
      -o /out/cloudflared-guard ./cloudflared-guard.go

# The latest official 2026.8.3 image still embeds vulnerable Go dependencies.
# Rebuild that same release with the checked-in security updates, preserving its
# upstream module replacements and container-specific build settings.
FROM --platform=$BUILDPLATFORM golang:1.27.1-alpine3.24@sha256:cf6fca6641884b8433441b2b0652976f975e1d0fdd26d177eaaf8596087f3125 AS cloudflared-build

ARG TARGETOS
ARG TARGETARCH
ENV GOPROXY=https://proxy.golang.org \
    GOSUMDB=sum.golang.org \
    GOTOOLCHAIN=local
WORKDIR /build/cloudflared
ADD --checksum=sha256:908aab97646925b8df7cd832c3aed96113cff070d3b41f665ffa55a86f1b04b5 \
    https://codeload.github.com/cloudflare/cloudflared/tar.gz/fe70e951a3c52d92abf9f6c4248e32937b2f42fc \
    /tmp/cloudflared.tar.gz
RUN tar -xzf /tmp/cloudflared.tar.gz --strip-components=1 \
    && rm /tmp/cloudflared.tar.gz
COPY deploy/docker/cloudflared/go.mod deploy/docker/cloudflared/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    test "$TARGETOS" = linux \
    && build_time="$(date -u -r RELEASE_NOTES '+%Y-%m-%d-%H:%M UTC')" \
    && CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
      go build -mod=readonly -trimpath -buildvcs=false \
      -ldflags "-s -w -buildid= -X main.Version=2026.8.3 -X 'main.BuildTime=$build_time' -X github.com/cloudflare/cloudflared/metrics.Runtime=virtual" \
      -o /out/cloudflared ./cmd/cloudflared \
    && go mod verify

FROM gcr.io/distroless/base-debian13:nonroot@sha256:d199d20fb09c898d8822ae5cbd5cf3c6d424e9b5e1fc2eb9a719a7752cd9d861

LABEL org.opencontainers.image.source="https://github.com/cloudflare/cloudflared" \
      org.opencontainers.image.revision="fe70e951a3c52d92abf9f6c4248e32937b2f42fc" \
      org.opencontainers.image.version="2026.8.3"

COPY --from=cloudflared-build --chown=0:0 --chmod=0755 \
  /out/cloudflared /usr/local/bin/cloudflared
COPY --from=cloudflared-build --chown=0:0 --chmod=0644 \
  /build/cloudflared/LICENSE /usr/share/licenses/cloudflared/LICENSE

COPY --from=launcher-build --chown=0:0 --chmod=0755 \
  /out/cloudflared-guard /usr/local/bin/cloudflared-guard

# The guard needs SETUID/SETGID plus transient SETPCAP at container startup. It
# validates and opens the root-only credential, activates no-new-privileges,
# clears the capability bounding set and groups, drops permanently to
# 65532:65532, verifies every process capability set is zero, and then execs
# cloudflared as PID 1.
USER 0:0
ENTRYPOINT ["/usr/local/bin/cloudflared-guard"]
CMD ["run"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/usr/local/bin/cloudflared-guard", "ready"]
