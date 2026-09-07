#!/usr/bin/env bash
set -euo pipefail

# Run against the repository containing this script, independent of caller cwd.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

docker image inspect vpn-gateway:local >"$RUNNER_TEMP/gateway-image.json"
docker image inspect vpn-cloudflared:local >"$RUNNER_TEMP/tunnel-image.json"

jq --exit-status '
  .[0].Os == "linux"
  and .[0].Architecture == "amd64"
  and .[0].Config.ExposedPorts == null
  and .[0].Config.User == "root:root"
  and .[0].Config.Entrypoint == ["/app/entrypoint.sh"]
  and .[0].Config.Cmd == null
  and .[0].Config.WorkingDir == "/app"
  and .[0].Config.Volumes == {"/data": {}}
  and .[0].Config.Healthcheck.Test
    == ["CMD", "node", "/app/src/runtime/healthcheck.js"]
  and all(.[0].Config.Env[]; test("TOKEN="; "i") | not)
' "$RUNNER_TEMP/gateway-image.json"
jq --exit-status '
  .[0].Os == "linux"
  and .[0].Architecture == "amd64"
  and .[0].Config.ExposedPorts == null
  and .[0].Config.User == "0:0"
  and .[0].Config.Entrypoint
    == ["/usr/local/bin/cloudflared-guard"]
  and .[0].Config.Cmd == ["run"]
  and .[0].Config.Volumes == null
  and .[0].Config.Healthcheck.Test
    == ["CMD", "/usr/local/bin/cloudflared-guard", "ready"]
  and all(.[0].Config.Env[]; test("TOKEN="; "i") | not)
' "$RUNNER_TEMP/tunnel-image.json"

gateway_id="$(docker create vpn-gateway:local)"
tunnel_id="$(docker create vpn-cloudflared:local)"
trap 'docker rm -f "$gateway_id" "$tunnel_id" >/dev/null 2>&1 || true' EXIT
docker export "$gateway_id" | tar -tf - >"$RUNNER_TEMP/gateway-files.txt"
docker export "$tunnel_id" | tar -tf - >"$RUNNER_TEMP/tunnel-files.txt"

grep -Fx 'app/package.json' "$RUNNER_TEMP/gateway-files.txt"
grep -Fx 'app/entrypoint.sh' "$RUNNER_TEMP/gateway-files.txt"
grep -Fx 'app/src/core/server-render.js' "$RUNNER_TEMP/gateway-files.txt"
grep -Fx 'usr/local/bin/sing-box' "$RUNNER_TEMP/gateway-files.txt"
grep -Fx 'usr/local/bin/cloudflared' "$RUNNER_TEMP/tunnel-files.txt"
grep -Fx 'usr/local/bin/cloudflared-guard' "$RUNNER_TEMP/tunnel-files.txt"

test "$(docker run --rm --entrypoint stat vpn-gateway:local \
  -c '%u:%g:%a:%h' /app/entrypoint.sh)" = '0:0:755:1'
test "$(docker run --rm --entrypoint stat vpn-gateway:local \
  -c '%u:%g:%a:%h' /app/package.json)" = '0:0:644:1'
test "$(docker run --rm --entrypoint stat vpn-gateway:local \
  -c '%u:%g:%a:%h' /app/src/core/server-render.js)" = '0:0:644:1'
test "$(docker run --rm --entrypoint stat vpn-gateway:local \
  -c '%u:%g:%a:%h' /usr/local/bin/sing-box)" = '0:0:755:1'

if grep -Eq '(^|/)(\.env|\.git)(/|$)|^(app/)?tests?(/|$)|^(go|build|root/\.cache/go-build)(/|$)|^usr/local/go(/|$)' \
  "$RUNNER_TEMP/gateway-files.txt"; then
  echo 'The gateway image contains forbidden source or build content.' >&2
  exit 1
fi
if grep -Eq '(^|/)(\.env|\.git)(/|$)|^(app/)?tests?(/|$)|^(go|build|root/\.cache/go-build)(/|$)|^usr/local/go(/|$)|cloudflared-guard\.go$' \
  "$RUNNER_TEMP/tunnel-files.txt"; then
  echo 'The cloudflared image contains forbidden source or build content.' >&2
  exit 1
fi

mkdir -p "$RUNNER_TEMP/gateway-source"
docker cp "$gateway_id:/app/src/." "$RUNNER_TEMP/gateway-source"
docker cp "$gateway_id:/app/package.json" "$RUNNER_TEMP/image-package.json"
docker cp "$gateway_id:/app/entrypoint.sh" "$RUNNER_TEMP/image-entrypoint.sh"
diff -ru --no-dereference src "$RUNNER_TEMP/gateway-source"
diff -u package.json "$RUNNER_TEMP/image-package.json"
diff -u deploy/docker/entrypoint.sh "$RUNNER_TEMP/image-entrypoint.sh"

if docker run --rm vpn-cloudflared:local unsupported \
  >"$RUNNER_TEMP/guard-output.txt" 2>&1; then
  echo 'The guard accepted an unsupported mode.' >&2
  exit 1
fi
grep -Fx 'cloudflared credential launcher: unsupported mode' \
  "$RUNNER_TEMP/guard-output.txt"
test "$(wc -l <"$RUNNER_TEMP/guard-output.txt")" -eq 1

if docker run --rm \
  --user 0:0 \
  --read-only \
  --tmpfs /tmp:size=4m,mode=1777,nosuid,nodev,noexec \
  --pids-limit 64 \
  --cap-drop ALL \
  --cap-add SETGID \
  --cap-add SETPCAP \
  --cap-add SETUID \
  --security-opt no-new-privileges:true \
  vpn-cloudflared:local ready \
  >"$RUNNER_TEMP/guard-ready-output.txt" 2>&1; then
  echo 'The guard reported a nonexistent readiness endpoint as healthy.' >&2
  exit 1
fi
grep -F 'http://127.0.0.1:2000/ready' \
  "$RUNNER_TEMP/guard-ready-output.txt"
grep -F 'connection refused' "$RUNNER_TEMP/guard-ready-output.txt"
if grep -Fq 'cloudflared credential launcher:' \
  "$RUNNER_TEMP/guard-ready-output.txt"; then
  echo 'The guard could not execute cloudflared under the Compose security settings.' >&2
  exit 1
fi

printf 'synthetic-ci-token\n' >"$RUNNER_TEMP/token-source"
sudo install -o root -g root -m 0400 \
  "$RUNNER_TEMP/token-source" \
  "$RUNNER_TEMP/cloudflare-tunnel-token"
if docker run --rm \
  --user 0:0 \
  --read-only \
  --tmpfs /tmp:size=4m,mode=1777,nosuid,nodev,noexec \
  --pids-limit 64 \
  --cap-drop ALL \
  --cap-add SETGID \
  --cap-add SETPCAP \
  --cap-add SETUID \
  --security-opt no-new-privileges:true \
  --mount "type=bind,source=$RUNNER_TEMP/cloudflare-tunnel-token,target=/run/secrets/cloudflare-tunnel-token,readonly" \
  vpn-cloudflared:local run \
  >"$RUNNER_TEMP/guard-run-output.txt" 2>&1; then
  echo 'Cloudflared accepted the synthetic invalid token.' >&2
  exit 1
fi
grep -Fx 'Provided Tunnel token is not valid.' \
  "$RUNNER_TEMP/guard-run-output.txt"
if grep -Fq 'cloudflared credential launcher:' \
  "$RUNNER_TEMP/guard-run-output.txt"; then
  echo 'The guard run path failed before cloudflared parsed the synthetic token.' >&2
  exit 1
fi
