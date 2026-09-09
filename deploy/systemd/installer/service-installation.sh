# shellcheck shell=bash
# Install managed service units and define origin verification.

for unit_file in "${UNIT_FILES[@]}"; do
  install -o root -g root -m 0644 "$REPO_DIR/deploy/systemd/$unit_file" "$SYSTEMD_ROOT/$unit_file"
done

systemd-analyze verify "${UNIT_FILES[@]/#/$SYSTEMD_ROOT/}"

systemctl daemon-reload
# The controller owns sing-box startup because its recovery transaction must
# select/validate the runtime revision before starting the data plane. Remove
# any stale enablement link from an earlier deployment so target startup cannot
# race the controller's fixed `systemctl restart` operation.
systemctl disable vpn-gateway-sing-box.service >/dev/null 2>&1 \
  || die "Could not keep vpn-gateway-sing-box.service disabled."
gateway_singbox_enablement="$(query_upgrade_enablement vpn-gateway-sing-box.service yes)"
[[ "$gateway_singbox_enablement" != enabled ]] \
  || die "vpn-gateway-sing-box.service remained enabled."

verify_bare_loopback_origins() {
  env -i \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "VPN_PUBLIC_HOSTNAME=$VPN_PUBLIC_HOSTNAME" \
    "WS_PATH=$WS_PATH" \
    "$NODE_BIN" --input-type=module --eval '
      import { randomBytes } from "node:crypto";
      import { readFile } from "node:fs/promises";
      import http from "node:http";

      const listenAddresses = new Map();
      for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
        const family = table.endsWith("6") ? 6 : 4;
        let text;
        try {
          text = await readFile(table, "utf8");
        } catch (error) {
          if (family === 6 && error?.code === "ENOENT") continue;
          throw error;
        }
        for (const line of text.trim().split("\n").slice(1)) {
          const columns = line.trim().split(/\s+/u);
          if (columns[3] !== "0A") continue;
          const [address, portHex] = columns[1].split(":");
          const port = Number.parseInt(portHex, 16);
          const records = listenAddresses.get(port) ?? [];
          records.push({ family, address });
          listenAddresses.set(port, records);
        }
      }
      if ((listenAddresses.get(443) ?? []).length !== 0) {
        throw new Error("TCP 443 is listening on the origin host");
      }
      for (const port of [8443, 8080, 8081, 20241]) {
        const records = listenAddresses.get(port) ?? [];
        if (records.length < 1 || records.some(({ family, address }) => family !== 4 || address !== "0100007F")) {
          throw new Error("TCP " + port + " is not exclusively bound to IPv4 loopback");
        }
      }

      const request = (options, expectUpgrade = false) => new Promise((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port: 8443,
          timeout: 5000,
          ...options,
        });
        req.once("timeout", () => req.destroy(new Error("origin request timed out")));
        req.once("error", (error) => {
          if (expectUpgrade) reject(error);
          else resolve("closed");
        });
        req.once("response", (response) => {
          response.resume();
          if (expectUpgrade) reject(new Error("canonical WebSocket path did not upgrade"));
          else resolve(response.statusCode);
        });
        req.once("upgrade", (_response, socket) => {
          socket.destroy();
          if (expectUpgrade) resolve(101);
          else reject(new Error("ordinary request unexpectedly upgraded"));
        });
        req.end();
      });

      const rejectedStatus = await request({
        method: "GET",
        path: "/__vpn_gateway_invalid_websocket_path__",
        headers: { Host: process.env.VPN_PUBLIC_HOSTNAME },
      });
      if (rejectedStatus !== "closed" && (!Number.isInteger(rejectedStatus) || rejectedStatus < 400)) {
        throw new Error("incorrect WebSocket path was not rejected");
      }
      const ordinaryStatus = await request({
        method: "GET",
        path: process.env.WS_PATH,
        headers: { Host: process.env.VPN_PUBLIC_HOSTNAME },
      });
      if (ordinaryStatus !== "closed" && (!Number.isInteger(ordinaryStatus) || ordinaryStatus < 400)) {
        throw new Error("ordinary HTTP request on the canonical WebSocket path was not rejected");
      }
      await request({
        method: "GET",
        path: process.env.WS_PATH,
        headers: {
          Host: process.env.VPN_PUBLIC_HOSTNAME,
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
          "Sec-WebSocket-Version": "13",
        },
      }, true);
    '
}
