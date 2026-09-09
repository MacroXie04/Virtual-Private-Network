#!/usr/bin/env bash
set -euo pipefail

# Run against the repository containing this script, independent of caller cwd.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

jq --exit-status --arg workspace "$GITHUB_WORKSPACE" '
  def normalize_bind:
    if .type == "bind" and .bind == {} then
      .bind = {"create_host_path": false}
    else
      .
    end;
  (.services["vpn-gateway"].volumes
    | map(normalize_bind)
    | map({key: .target, value: .})
    | from_entries) as $gateway_mounts
  | (.services | keys | sort) == ["cloudflared", "vpn-gateway"]
  and (.services["vpn-gateway"] | keys | sort) == ([
    "build", "cap_add", "cap_drop", "command", "entrypoint",
    "environment", "healthcheck", "image", "init", "logging",
    "networks", "pids_limit", "read_only", "restart",
    "security_opt", "stop_grace_period", "tmpfs", "user",
    "volumes"
  ] | sort)
  and (.services.cloudflared | keys | sort) == ([
    "build", "cap_add", "cap_drop", "command", "depends_on",
    "entrypoint", "healthcheck", "image", "logging",
    "network_mode", "pids_limit", "read_only", "restart",
    "security_opt", "stop_grace_period", "tmpfs", "user",
    "volumes"
  ] | sort)
  and all(
    .services[];
    (has("ports") | not)
    and (has("expose") | not)
    and ((.network_mode // "") != "host")
    and ((.privileged // false) == false)
    and (has("pid") | not)
    and (has("ipc") | not)
    and (has("uts") | not)
    and (has("cgroup") | not)
    and (has("devices") | not)
    and (has("device_cgroup_rules") | not)
    and (has("volumes_from") | not)
    and (has("secrets") | not)
    and (has("configs") | not)
    and (has("use_api_socket") | not)
    and (has("post_start") | not)
    and (has("pre_stop") | not)
    and .entrypoint == null
    and .command == null
    and .read_only == true
    and .cap_drop == ["ALL"]
    and .security_opt == ["no-new-privileges:true"]
    and .user == "0:0"
  )
  and .networks == {
    "default": {
      "name": "vpn-ci-policy_default",
      "ipam": {}
    }
  }
  and .volumes == {
    "vpn-data": {
      "name": "vpn-ci-policy_vpn-data"
    }
  }
  and .services["vpn-gateway"].image == "vpn-gateway:local"
  and .services["vpn-gateway"].build == {
    "context": $workspace,
    "dockerfile": "deploy/docker/Dockerfile"
  }
  and (.services["vpn-gateway"] | has("network_mode") | not)
  and .services["vpn-gateway"].networks == {"default": null}
  and .services["vpn-gateway"].init == true
  and .services["vpn-gateway"].pids_limit == 128
  and .services["vpn-gateway"].restart == "unless-stopped"
  and .services["vpn-gateway"].stop_grace_period == "5m30s"
  and .services["vpn-gateway"].tmpfs == [
    "/run:size=4m,mode=0755,nosuid,nodev,noexec",
    "/tmp:size=16m,mode=1777,nosuid,nodev,noexec"
  ]
  and .services["vpn-gateway"].healthcheck == {
    "test": ["CMD", "node", "/app/src/runtime/healthcheck.js"],
    "timeout": "10s",
    "interval": "30s",
    "retries": 3,
    "start_period": "20s"
  }
  and .services["vpn-gateway"].logging == {
    "driver": "local",
    "options": {
      "compress": "true",
      "max-file": "3",
      "max-size": "10m"
    }
  }
  and .services.cloudflared.network_mode == "service:vpn-gateway"
  and .services.cloudflared.image == "vpn-cloudflared:local"
  and .services.cloudflared.build == {
    "context": $workspace,
    "dockerfile": "deploy/docker/cloudflared.Dockerfile"
  }
  and .services.cloudflared.pids_limit == 64
  and .services.cloudflared.restart == "unless-stopped"
  and .services.cloudflared.stop_grace_period == "45s"
  and .services.cloudflared.depends_on == {
    "vpn-gateway": {
      "condition": "service_started",
      "restart": true,
      "required": true
    }
  }
  and .services.cloudflared.tmpfs == [
    "/tmp:size=4m,mode=1777,nosuid,nodev,noexec"
  ]
  and .services.cloudflared.healthcheck == {
    "test": ["CMD", "/usr/local/bin/cloudflared-guard", "ready"],
    "timeout": "5s",
    "interval": "30s",
    "retries": 3,
    "start_period": "20s"
  }
  and .services.cloudflared.logging == {
    "driver": "local",
    "options": {
      "compress": "true",
      "max-file": "3",
      "max-size": "10m"
    }
  }
  and (.services.cloudflared | has("environment") | not)
  and (.services.cloudflared.cap_add | sort)
    == (["SETGID", "SETPCAP", "SETUID"] | sort)
  and (.services.cloudflared.volumes | map(normalize_bind)) == [{
    "type": "bind",
    "source": "/dev/null",
    "target": "/run/secrets/cloudflare-tunnel-token",
    "read_only": true,
    "bind": {"create_host_path": false}
  }]
  and (.services["vpn-gateway"].cap_add | sort)
    == (["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"] | sort)
  and (.services["vpn-gateway"].volumes | length) == 3
  and ([.services["vpn-gateway"].volumes[].target] | sort)
    == (["/data", "/run/secrets/tailscale-api-key", "/run/secrets/tailscale-auth-key"] | sort)
  and $gateway_mounts["/data"] == {
    "type": "volume",
    "source": "vpn-data",
    "target": "/data",
    "volume": {"nocopy": true}
  }
  and $gateway_mounts["/run/secrets/tailscale-auth-key"] == {
    "type": "bind",
    "source": "/dev/null",
    "target": "/run/secrets/tailscale-auth-key",
    "read_only": true,
    "bind": {"create_host_path": false}
  }
  and $gateway_mounts["/run/secrets/tailscale-api-key"] == {
    "type": "bind",
    "source": "/dev/null",
    "target": "/run/secrets/tailscale-api-key",
    "read_only": true,
    "bind": {"create_host_path": false}
  }
  and .services["vpn-gateway"].environment == {
    "ADMIN_GID": "11002",
    "ADMIN_HOST": "127.0.0.1",
    "ADMIN_PORT": "8081",
    "ADMIN_PUBLIC_HOSTNAME": "admin.example.com",
    "ADMIN_UID": "11002",
    "CONTROLLER_SOCKET": "/run/vpn-gateway/controller.sock",
    "DATA_DIR": "/data",
    "EGRESS_HEALTH_HOST": "health.example.net",
    "EXIT_NODE": "100.64.0.10",
    "NODE_ENV": "production",
    "NODE_HOST": "127.0.0.1",
    "NODE_NAME": "vpn-ci",
    "NODE_PORT": "8443",
    "SINGBOX_BIN": "/usr/local/bin/sing-box",
    "SINGBOX_CONFIG": "/data/runtime/sing-box.json",
    "SINGBOX_GID": "11000",
    "SINGBOX_STATE_DIR": "/data/tailscale",
    "SINGBOX_UID": "11000",
    "SUBSCRIPTION_PUBLIC_BASE_URL": "https://sub.example.com",
    "SUB_GID": "11001",
    "SUB_HOST": "127.0.0.1",
    "SUB_PORT": "8080",
    "SUB_UID": "11001",
    "SUPERVISE": "1",
    "TS_API_KEY_FILE": "",
    "TS_AUTH_KEY_FILE": "/run/secrets/tailscale-auth-key",
    "VPN_PUBLIC_HOSTNAME": "vpn.example.com",
    "WS_PATH": "/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  }
' "$RUNNER_TEMP/compose.json"

jq --slurp --exit-status '
  .[0] as $without_api
  | .[1] as $with_api
  | $with_api.services["vpn-gateway"].environment.TS_API_KEY_FILE
      == "/run/secrets/tailscale-api-key"
    and ($with_api
      | .services["vpn-gateway"].environment.TS_API_KEY_FILE = "")
      == $without_api
' \
  "$RUNNER_TEMP/compose.json" \
  "$RUNNER_TEMP/compose-api-key.json"
