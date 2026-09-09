# shellcheck shell=bash
# Validate Cloudflare ingress settings and read canonical deployment configuration.

validate_cloudflare_tunnel_token_file() {
  local token_path="$1"
  local token_label="$2"
  [[ "$token_path" == /* ]] || die "$token_label must be an absolute path."
  env -i \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$NODE_BIN" --input-type=module --eval '
      import { constants } from "node:fs";
      import { lstat, open } from "node:fs/promises";

      const source = process.argv[1];
      let handle;
      const reject = (detail) => {
        throw new Error("invalid Cloudflare Tunnel token file: " + detail);
      };
      try {
        handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await handle.stat();
        const pathname = await lstat(source);
        const mode = before.mode & 0o777;
        if (!before.isFile() || before.nlink !== 1 || before.uid !== 0 || before.gid !== 0
            || ![0o400, 0o600].includes(mode) || before.size < 32 || before.size > 16 * 1024
            || pathname.isSymbolicLink() || pathname.dev !== before.dev || pathname.ino !== before.ino) {
          reject("source must be root-owned, singly linked, mode 0400/0600, and 32 bytes to 16 KiB");
        }
        const bytes = await handle.readFile();
        const after = await handle.stat();
        const finalPathname = await lstat(source);
        if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino
            || after.uid !== before.uid || after.gid !== before.gid || after.nlink !== before.nlink
            || after.size !== before.size || (after.mode & 0o777) !== mode
            || finalPathname.isSymbolicLink() || finalPathname.dev !== before.dev
            || finalPathname.ino !== before.ino) {
          reject("source identity changed while it was read");
        }
        const fileText = bytes.toString("utf8");
        if (!Buffer.from(fileText, "utf8").equals(bytes) || fileText.includes("\0") || fileText.includes("\r")) {
          reject("content must be UTF-8 without NUL or carriage returns");
        }
        const token = fileText.endsWith("\n") ? fileText.slice(0, -1) : fileText;
        if (!token || token.includes("\n") || token !== token.trim()
            || !/^[A-Za-z0-9+/]+={0,2}$/u.test(token) || token.length % 4 !== 0) {
          reject("content must be exactly one canonical base64 token");
        }
        const decoded = Buffer.from(token, "base64");
        if (decoded.toString("base64") !== token) reject("outer token encoding is not canonical base64");
        const jsonText = decoded.toString("utf8");
        if (!Buffer.from(jsonText, "utf8").equals(decoded)) reject("decoded token is not UTF-8 JSON");
        let payload;
        try { payload = JSON.parse(jsonText); } catch { reject("decoded token is not JSON"); }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) reject("decoded token is not an object");
        const keys = Object.keys(payload).sort();
        if (!keys.every((key) => ["a", "e", "s", "t"].includes(key))
            || !keys.includes("a") || !keys.includes("s") || !keys.includes("t")) {
          reject("decoded token has an unsupported shape");
        }
        if (typeof payload.a !== "string" || payload.a.length < 1 || payload.a.length > 256
            || /[\u0000-\u001f\u007f]/u.test(payload.a)) reject("account tag is invalid");
        if (typeof payload.s !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload.s)
            || payload.s.length % 4 !== 0) reject("tunnel secret is invalid");
        const tunnelSecret = Buffer.from(payload.s, "base64");
        if (tunnelSecret.length < 16 || tunnelSecret.toString("base64") !== payload.s) {
          reject("tunnel secret encoding is invalid");
        }
        if (typeof payload.t !== "string"
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(payload.t)) {
          reject("tunnel identifier is invalid");
        }
        if (payload.e !== undefined && (typeof payload.e !== "string" || payload.e.length > 2048
            || /[\u0000-\u001f\u007f]/u.test(payload.e))) reject("endpoint is invalid");
      } finally {
        await handle?.close().catch(() => {});
      }
    ' "$token_path" >/dev/null \
    || die "$token_label is not a safe, valid Cloudflare Tunnel token file."
}

generate_websocket_path() {
  "$NODE_BIN" --input-type=module --eval \
    'import { randomBytes } from "node:crypto"; process.stdout.write("/" + randomBytes(32).toString("base64url"));'
}

validate_cloudflare_ingress_settings() {
  local normalized_output
  local -a normalized_values
  normalized_output="$(
    env -i \
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
      "VALIDATION_MODULE=$REPO_DIR/src/core/validation/ingress.js" \
      "VPN_PUBLIC_HOSTNAME=$VPN_PUBLIC_HOSTNAME" \
      "SUBSCRIPTION_PUBLIC_BASE_URL=$SUBSCRIPTION_PUBLIC_BASE_URL" \
      "ADMIN_PUBLIC_HOSTNAME=$ADMIN_PUBLIC_HOSTNAME" \
      "WS_PATH=$WS_PATH" \
      "EGRESS_HEALTH_HOST=$EGRESS_HEALTH_HOST" \
      "$NODE_BIN" --input-type=module --eval '
        import { pathToFileURL } from "node:url";
        const {
          validatePublicDnsHostname,
          validatePublicIngressSettings,
        } = await import(pathToFileURL(process.env.VALIDATION_MODULE).href);
        const gateway = validatePublicIngressSettings({
          vpnPublicHostname: process.env.VPN_PUBLIC_HOSTNAME,
          subscriptionPublicBaseUrl: process.env.SUBSCRIPTION_PUBLIC_BASE_URL,
          adminPublicHostname: process.env.ADMIN_PUBLIC_HOSTNAME,
          websocketPath: process.env.WS_PATH,
        }, "Cloudflare ingress settings");
        const healthHost = validatePublicDnsHostname(
          process.env.EGRESS_HEALTH_HOST,
          "EGRESS_HEALTH_HOST",
        );
        const subscriptionHost = new URL(gateway.subscriptionPublicBaseUrl).hostname;
        if ([gateway.vpnPublicHostname, subscriptionHost, gateway.adminPublicHostname].includes(healthHost)) {
          throw new Error("EGRESS_HEALTH_HOST must be independent of all three Tunnel hostnames");
        }
        process.stdout.write([
          gateway.vpnPublicHostname,
          gateway.subscriptionPublicBaseUrl,
          gateway.adminPublicHostname,
          gateway.websocketPath,
          healthHost,
        ].join("\n"));
      '
  )" || die "The Cloudflare ingress or routed-health settings are invalid."
  mapfile -t normalized_values <<<"$normalized_output"
  (( ${#normalized_values[@]} == 5 )) \
    || die "The Cloudflare ingress settings validator returned an invalid result."
  VPN_PUBLIC_HOSTNAME="${normalized_values[0]}"
  SUBSCRIPTION_PUBLIC_BASE_URL="${normalized_values[1]}"
  ADMIN_PUBLIC_HOSTNAME="${normalized_values[2]}"
  WS_PATH="${normalized_values[3]}"
  EGRESS_HEALTH_HOST="${normalized_values[4]}"
}

collect_cloudflare_ingress_settings() {
  local allow_path_generation="$1"
  VPN_PUBLIC_HOSTNAME="${VPN_PUBLIC_HOSTNAME:-}"
  SUBSCRIPTION_PUBLIC_BASE_URL="${SUBSCRIPTION_PUBLIC_BASE_URL:-}"
  ADMIN_PUBLIC_HOSTNAME="${ADMIN_PUBLIC_HOSTNAME:-}"
  WS_PATH="${WS_PATH:-}"
  EGRESS_HEALTH_HOST="${EGRESS_HEALTH_HOST:-}"

  prompt_required VPN_PUBLIC_HOSTNAME "Public VPN Tunnel hostname" no
  prompt_required SUBSCRIPTION_PUBLIC_BASE_URL "Public subscription HTTPS origin" no
  prompt_required ADMIN_PUBLIC_HOSTNAME "Public administration Tunnel hostname" no
  if [[ -z "$WS_PATH" ]]; then
    if [[ "$allow_path_generation" == yes ]]; then
      WS_PATH="$(generate_websocket_path)"
    else
      die "WS_PATH must be set for this deployment."
    fi
  fi
  prompt_required EGRESS_HEALTH_HOST "Independent operator-controlled egress health hostname" no
  validate_cloudflare_ingress_settings
}

assert_supported_data_directory() {
  local inspection_root="$1"
  local check_pointers="${2:-yes}"
  env -i \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "DATA_DIR=$inspection_root" \
    "SUBSCRIPTION_GID=$(resolve_service_id group vpn-sub 11001 yes)" \
    "CHECK_POINTERS=$check_pointers" \
    "STATE_MODULE_ROOT=$REPO_DIR/src/state" \
    "$NODE_BIN" --input-type=module --eval '
      import { pathToFileURL } from "node:url";
      const { assertSupportedDataDirectory } = await import(
        pathToFileURL(process.env.STATE_MODULE_ROOT + "/bootstrap/recovery.js").href
      );
      await assertSupportedDataDirectory(process.env.DATA_DIR);
      if (process.env.CHECK_POINTERS === "yes") {
        const { RevisionRepository } = await import(
          pathToFileURL(process.env.STATE_MODULE_ROOT + "/repository.js").href
        );
        const repository = new RevisionRepository(process.env.DATA_DIR, {
          runtimeGid: 11000,
          subscriptionGid: Number(process.env.SUBSCRIPTION_GID),
        });
        const current = await repository.readCurrent();
        const runtimeId = await repository.readPointer("runtime");
        if (current && runtimeId !== null && runtimeId !== current.id) {
          await repository.assertSupportedRevisionSchema(runtimeId);
        } else if (!current) {
          const runtime = await repository.readRuntime();
          if (runtime?.manifest.operation === "ingress.migrate") {
            throw new Error("Uncommitted conversion data is unsupported; use a new data directory.");
          }
        }
      }
    '
}

inspect_current_state_for_installer() {
  env -i \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "DATA_DIR=$STATE_ROOT" \
    "SUBSCRIPTION_GID=$(resolve_service_id group vpn-sub 11001 yes)" \
    "REPOSITORY_MODULE=$REPO_DIR/src/state/repository.js" \
    "$NODE_BIN" --input-type=module --eval '
      import { pathToFileURL } from "node:url";
      const { RevisionRepository } = await import(pathToFileURL(process.env.REPOSITORY_MODULE).href);
      const repository = new RevisionRepository(process.env.DATA_DIR, {
        runtimeGid: 11000,
        subscriptionGid: Number(process.env.SUBSCRIPTION_GID),
      });
      const current = await repository.readCurrent();
      const revision = current ?? await repository.readRuntime();
      if (!revision) throw new Error("no current or runtime revision pointer exists");
      const state = revision.state;
      process.stdout.write(JSON.stringify({
        schemaVersion: state.schemaVersion,
        vpnPublicHostname: state.gateway.vpnPublicHostname,
        subscriptionPublicBaseUrl: state.gateway.subscriptionPublicBaseUrl,
        adminPublicHostname: state.gateway.adminPublicHostname,
        websocketPath: state.gateway.websocketPath,
        egressHealthHost: state.health.target.host,
      }));
    '
}

read_installer_json_field() {
  local json_document="$1"
  local field_name="$2"
  printf '%s' "$json_document" \
    | "$NODE_BIN" -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const value = JSON.parse(input)[process.argv[1]];
        if (typeof value !== "string" && !Number.isInteger(value)) process.exit(2);
        process.stdout.write(String(value));
      });
    ' "$field_name"
}

require_matching_canonical_setting() {
  local setting_name="$1"
  local supplied_value="$2"
  local canonical_value="$3"
  if [[ -n "$supplied_value" && "$supplied_value" != "$canonical_value" ]]; then
    die "$setting_name conflicts with canonical state; change public settings through the controller rather than the installer."
  fi
}

read_generated_environment_value() {
  local environment_path="$1"
  local setting_name="$2"
  # The embedded JavaScript replacement string "$1" must remain literal.
  # shellcheck disable=SC2016
  env -i \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$NODE_BIN" --input-type=module --eval '
      import { constants } from "node:fs";
      import { lstat, open } from "node:fs/promises";
      const source = process.argv[1];
      const requested = process.argv[2];
      let handle;
      try {
        handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await handle.stat();
        const pathname = await lstat(source);
        if (!before.isFile() || before.uid !== 0 || before.gid !== 0 || before.nlink !== 1
            || (before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > 64 * 1024
            || pathname.isSymbolicLink() || pathname.dev !== before.dev || pathname.ino !== before.ino) {
          throw new Error("environment file is unsafe");
        }
        const text = await handle.readFile({ encoding: "utf8" });
        const after = await handle.stat();
        const finalPathname = await lstat(source);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
            || after.uid !== before.uid || after.gid !== before.gid || after.nlink !== before.nlink
            || (after.mode & 0o777) !== (before.mode & 0o777)
            || finalPathname.isSymbolicLink() || finalPathname.dev !== before.dev
            || finalPathname.ino !== before.ino) {
          throw new Error("environment file changed while it was read");
        }
        let result;
        for (const line of text.split("\n")) {
          if (!line) continue;
          const match = /^([A-Z][A-Z0-9_]*)="((?:[^"\\\r\n]|\\["\\])*)"$/u.exec(line);
          if (!match) throw new Error("environment file has unsupported syntax");
          if (match[1] !== requested) continue;
          if (result !== undefined) throw new Error("environment setting is duplicated");
          result = match[2].replace(/\\(["\\])/gu, "$1");
        }
        if (result === undefined || /[\r\n\0]/u.test(result)) throw new Error("environment setting is missing or unsafe");
        process.stdout.write(result);
      } finally {
        await handle?.close().catch(() => {});
      }
    ' "$environment_path" "$setting_name"
}

load_ingress_settings_from_controller_environment() {
  local stored_vpn stored_subscription stored_admin stored_path stored_health
  stored_vpn="$(read_generated_environment_value "$CONTROLLER_ENV" VPN_PUBLIC_HOSTNAME)" \
    || die "$CONTROLLER_ENV does not contain safe Cloudflare ingress settings."
  stored_subscription="$(read_generated_environment_value "$CONTROLLER_ENV" SUBSCRIPTION_PUBLIC_BASE_URL)" \
    || die "$CONTROLLER_ENV does not contain safe Cloudflare ingress settings."
  stored_admin="$(read_generated_environment_value "$CONTROLLER_ENV" ADMIN_PUBLIC_HOSTNAME)" \
    || die "$CONTROLLER_ENV does not contain safe Cloudflare ingress settings."
  stored_path="$(read_generated_environment_value "$CONTROLLER_ENV" WS_PATH)" \
    || die "$CONTROLLER_ENV does not contain safe Cloudflare ingress settings."
  stored_health="$(read_generated_environment_value "$CONTROLLER_ENV" EGRESS_HEALTH_HOST)" \
    || die "$CONTROLLER_ENV does not contain safe Cloudflare ingress settings."
  require_matching_canonical_setting VPN_PUBLIC_HOSTNAME "${VPN_PUBLIC_HOSTNAME:-}" "$stored_vpn"
  require_matching_canonical_setting SUBSCRIPTION_PUBLIC_BASE_URL "${SUBSCRIPTION_PUBLIC_BASE_URL:-}" "$stored_subscription"
  require_matching_canonical_setting ADMIN_PUBLIC_HOSTNAME "${ADMIN_PUBLIC_HOSTNAME:-}" "$stored_admin"
  require_matching_canonical_setting WS_PATH "${WS_PATH:-}" "$stored_path"
  require_matching_canonical_setting EGRESS_HEALTH_HOST "${EGRESS_HEALTH_HOST:-}" "$stored_health"
  VPN_PUBLIC_HOSTNAME="$stored_vpn"
  SUBSCRIPTION_PUBLIC_BASE_URL="$stored_subscription"
  ADMIN_PUBLIC_HOSTNAME="$stored_admin"
  WS_PATH="$stored_path"
  EGRESS_HEALTH_HOST="$stored_health"
  validate_cloudflare_ingress_settings
}
