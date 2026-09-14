#!/usr/bin/env bash
set -euo pipefail

# Run against the repository containing this script, independent of caller cwd.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

ruby -ryaml -e '
  compose = YAML.safe_load(
    File.read("docker-compose.yml"),
    permitted_classes: [],
    permitted_symbols: [],
    aliases: false
  )
  expected = [
    ["cloudflared", "/run/secrets/cloudflare-tunnel-token"],
    ["vpn-gateway", "/run/secrets/tailscale-api-key"],
    ["vpn-gateway", "/run/secrets/tailscale-auth-key"]
  ]
  actual = []
  compose.fetch("services").each do |service, definition|
    definition.fetch("volumes", []).each do |volume|
      next unless volume.is_a?(Hash) && volume["type"] == "bind"

      identity = [service, volume["target"]]
      actual << identity
      abort "bind #{identity.join(":")} must disable host-path creation" unless
        volume.dig("bind", "create_host_path") == false
    end
  end
  abort "unexpected Compose bind mounts" unless actual.sort == expected.sort
  environment = compose.fetch("services").fetch("vpn-gateway").fetch("environment")
  abort "fresh subscription origin must be optional" unless
    environment.fetch("SUBSCRIPTION_PUBLIC_BASE_URL") == "${SUBSCRIPTION_PUBLIC_BASE_URL:-}"
  abort "public deployment must default local access off" unless
    environment.fetch("LOCAL_HTTP_ORIGIN") == "${LOCAL_HTTP_ORIGIN:-}"

  local = YAML.safe_load(
    File.read("docker-compose.local.yml"),
    permitted_classes: [],
    permitted_symbols: [],
    aliases: false
  )
  expected_local = {
    "services" => {
      "vpn-gateway" => {
        "environment" => {
          "ADMIN_HOST" => "0.0.0.0",
          "LOCAL_HTTP_ORIGIN" => "http://127.0.0.1:8081"
        },
        "ports" => ["127.0.0.1:8081:8081"]
      },
      "cloudflared" => {"profiles" => ["tunnel"]}
    }
  }
  abort "local override must only publish the loopback site and opt in to Tunnel startup" unless local == expected_local
'
