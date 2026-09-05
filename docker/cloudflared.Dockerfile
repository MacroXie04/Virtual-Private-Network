# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM golang:1.27.1-alpine3.24@sha256:cf6fca6641884b8433441b2b0652976f975e1d0fdd26d177eaaf8596087f3125 AS launcher-build

ARG TARGETOS
ARG TARGETARCH
WORKDIR /build
COPY docker/cloudflared-guard.go ./cloudflared-guard.go
RUN test "$TARGETOS" = linux \
    && CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
      go build -trimpath -ldflags "-s -w -buildid=" \
      -o /out/cloudflared-guard ./cloudflared-guard.go

FROM cloudflare/cloudflared:2026.8.3@sha256:51c9cefcb4569df44e1ad403ab1d3d8065aa8e84339bcfc6aee75502e1140339

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
