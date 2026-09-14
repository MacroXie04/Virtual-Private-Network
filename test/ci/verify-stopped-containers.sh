#!/usr/bin/env bash
set -euo pipefail

# Run against the repository containing this script, independent of caller cwd.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

docker compose -f docker-compose.yml create --no-build
gateway_id="$(docker compose -f docker-compose.yml ps -aq vpn-gateway)"
tunnel_id="$(docker compose -f docker-compose.yml ps -aq cloudflared)"
gateway_image="$(docker image inspect --format '{{.Id}}' vpn-gateway:local)"
tunnel_image="$(docker image inspect --format '{{.Id}}' vpn-cloudflared:local)"
gateway_network="${COMPOSE_PROJECT_NAME}_default"
test -n "$gateway_id"
test -n "$tunnel_id"

docker inspect "$gateway_id" >"$RUNNER_TEMP/gateway-inspect.json"
docker inspect "$tunnel_id" >"$RUNNER_TEMP/tunnel-inspect.json"
docker volume inspect "${COMPOSE_PROJECT_NAME}_vpn-data" \
  >"$RUNNER_TEMP/volume-inspect.json"
jq --exit-status '
  .[0].Driver == "local"
  and (.[0].Options == null or .[0].Options == {})
' "$RUNNER_TEMP/volume-inspect.json"

jq --exit-status \
  --arg gateway_image "$gateway_image" \
  --arg gateway_network "$gateway_network" '
  (.[0].Mounts
    | map({key: .Destination, value: .})
    | from_entries) as $mounts
  | .[0].Image == $gateway_image
  and .[0].Path == "/app/entrypoint.sh"
  and .[0].Args == []
  and .[0].Config.Image == "vpn-gateway:local"
  and .[0].Config.User == "0:0"
  and .[0].Config.Entrypoint == ["/app/entrypoint.sh"]
  and .[0].Config.Cmd == null
  and .[0].Config.WorkingDir == "/app"
  and .[0].Config.Healthcheck.Test
    == ["CMD", "node", "/app/src/runtime/healthcheck.js"]
  and .[0].Config.Healthcheck.Interval == 30000000000
  and .[0].Config.Healthcheck.Timeout == 10000000000
  and .[0].Config.Healthcheck.StartPeriod == 20000000000
  and .[0].Config.Healthcheck.Retries == 3
  and .[0].HostConfig.NetworkMode == $gateway_network
  and (.[0].HostConfig.PortBindings | length) == 0
  and (.[0].NetworkSettings.Ports | length) == 0
  and .[0].HostConfig.ReadonlyRootfs == true
  and .[0].HostConfig.PidsLimit == 128
  and .[0].HostConfig.SecurityOpt == ["no-new-privileges:true"]
  and .[0].HostConfig.Privileged == false
  and (.[0].HostConfig.CapAdd | sort)
    == (["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_KILL", "CAP_SETGID", "CAP_SETUID"] | sort)
  and .[0].HostConfig.CapDrop == ["ALL"]
  and .[0].HostConfig.PidMode == ""
  and .[0].HostConfig.IpcMode == "private"
  and .[0].HostConfig.CgroupnsMode == "private"
  and ((.[0].HostConfig.Devices // []) | length) == 0
  and ((.[0].HostConfig.VolumesFrom // []) | length) == 0
  and ((.[0].HostConfig.GroupAdd // []) | length) == 0
  and .[0].HostConfig.LogConfig == {
    "Type": "local",
    "Config": {
      "compress": "true",
      "max-file": "3",
      "max-size": "10m"
    }
  }
  and .[0].HostConfig.Tmpfs == {
    "/run": "size=4m,mode=0755,nosuid,nodev,noexec",
    "/tmp": "size=16m,mode=1777,nosuid,nodev,noexec"
  }
  and (.[0].Mounts | length) == 3
  and ($mounts["/data"] | {
    Type, Name, Destination, Driver, RW
  }) == {
    "Type": "volume",
    "Name": (env.COMPOSE_PROJECT_NAME + "_vpn-data"),
    "Destination": "/data",
    "Driver": "local",
    "RW": true
  }
  and ($mounts["/run/secrets/tailscale-auth-key"] | {
    Type, Source, Destination, RW
  }) == {
    "Type": "bind",
    "Source": "/dev/null",
    "Destination": "/run/secrets/tailscale-auth-key",
    "RW": false
  }
  and ($mounts["/run/secrets/tailscale-api-key"] | {
    Type, Source, Destination, RW
  }) == {
    "Type": "bind",
    "Source": "/dev/null",
    "Destination": "/run/secrets/tailscale-api-key",
    "RW": false
  }
  and all(.[0].Config.Env[]; test("TOKEN="; "i") | not)
' "$RUNNER_TEMP/gateway-inspect.json"
jq --exit-status \
  --arg gateway_id "$gateway_id" \
  --arg tunnel_image "$tunnel_image" '
  .[0].Image == $tunnel_image
  and .[0].Path == "/usr/local/bin/cloudflared-guard"
  and .[0].Args == ["run"]
  and .[0].Config.Image == "vpn-cloudflared:local"
  and .[0].Config.User == "0:0"
  and .[0].Config.Entrypoint
    == ["/usr/local/bin/cloudflared-guard"]
  and .[0].Config.Cmd == ["run"]
  and .[0].Config.Healthcheck.Test
    == ["CMD", "/usr/local/bin/cloudflared-guard", "ready"]
  and .[0].Config.Healthcheck.Interval == 30000000000
  and .[0].Config.Healthcheck.Timeout == 5000000000
  and .[0].Config.Healthcheck.StartPeriod == 20000000000
  and .[0].Config.Healthcheck.Retries == 3
  and .[0].HostConfig.NetworkMode == ("container:" + $gateway_id)
  and (.[0].HostConfig.PortBindings | length) == 0
  and (.[0].NetworkSettings.Ports | length) == 0
  and .[0].HostConfig.ReadonlyRootfs == true
  and .[0].HostConfig.PidsLimit == 64
  and .[0].HostConfig.SecurityOpt == ["no-new-privileges:true"]
  and .[0].HostConfig.Privileged == false
  and (.[0].HostConfig.CapAdd | sort)
    == (["CAP_SETGID", "CAP_SETPCAP", "CAP_SETUID"] | sort)
  and .[0].HostConfig.CapDrop == ["ALL"]
  and .[0].HostConfig.PidMode == ""
  and .[0].HostConfig.IpcMode == "private"
  and .[0].HostConfig.CgroupnsMode == "private"
  and ((.[0].HostConfig.Devices // []) | length) == 0
  and ((.[0].HostConfig.VolumesFrom // []) | length) == 0
  and ((.[0].HostConfig.GroupAdd // []) | length) == 0
  and .[0].HostConfig.LogConfig == {
    "Type": "local",
    "Config": {
      "compress": "true",
      "max-file": "3",
      "max-size": "10m"
    }
  }
  and .[0].HostConfig.Tmpfs == {
    "/tmp": "size=4m,mode=1777,nosuid,nodev,noexec"
  }
  and (.[0].Mounts | length) == 1
  and (.[0].Mounts[0] | {
    Type, Source, Destination, RW
  }) == {
    "Type": "bind",
    "Source": "/dev/null",
    "Destination": "/run/secrets/cloudflare-tunnel-token",
    "RW": false
  }
  and all(.[0].Config.Env[]; test("TOKEN="; "i") | not)
' "$RUNNER_TEMP/tunnel-inspect.json"
