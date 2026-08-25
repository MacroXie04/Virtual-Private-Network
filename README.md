# Virtual Private Network

VPS 代理后端：sing-box 提供 **VLESS + REALITY** 入站，出口流量经**内嵌 Tailscale（tsnet）**走指定 **Exit Node** 出网；附带一个零依赖的极简订阅服务。无需域名和证书。

```
客户端 → VLESS+REALITY → VPS (sing-box) → Tailscale 隧道 → Exit Node → 互联网
                              └─ 订阅服务 (Node, 端口 8080)
```

Tailscale 以 userspace 方式运行在 sing-box 进程内部，**不改 VPS 系统路由**，SSH 与入站代理连接不受影响。

## 前提

- 一台有公网 IP 的 VPS（Debian/Ubuntu）
- 一台已配好的 Tailscale Exit Node（`--advertise-exit-node` 并在管理后台批准）
- Tailscale 账号，后台 Settings → Keys 生成一个 auth key（建议 reusable、关闭 key expiry）

## 部署

```bash
git clone <本仓库> && cd Virtual-Private-Network
sudo bash server/install.sh
```

脚本会依次：

1. 安装 sing-box 与 Node.js（如缺失）
2. 提示输入 Tailscale auth key、Exit Node 地址、本机公网地址、REALITY 伪装域名
3. 生成 UUID、REALITY 密钥对、Short ID、订阅 token
4. 渲染 `/etc/sing-box/config.json`（模板：`server/config.template.json`）并 `sing-box check` 校验
5. 安装并启动 `sing-box.service` 与 `vpn-sub.service`（订阅服务）

结束后打印客户端参数与订阅地址。防火墙需放行 `443/tcp`；远程拉取订阅另需 `8080/tcp`。

## 订阅与客户端

浏览器直接访问 `http://<VPS>:8080/<SUB_TOKEN>` 会看到网页界面：节点信息、分享链接（含二维码）、各格式订阅地址一键复制、配置文件下载。

| 格式 | 地址 |
| --- | --- |
| 通用 mixed（base64 链接） | `http://<VPS>:8080/<SUB_TOKEN>` |
| sing-box 完整配置 | `http://<VPS>:8080/<SUB_TOKEN>/singbox` |
| Clash Meta (mihomo) | `http://<VPS>:8080/<SUB_TOKEN>/clash` |
| 纯文本分享链接 | `http://<VPS>:8080/<SUB_TOKEN>/links` |

不带后缀时按请求头嗅探：浏览器（Accept 含 text/html）给网页界面，sing-box / Clash 客户端自动给对应格式，其余给 mixed。v2rayN、Nekoray、Clash Verge (Meta 内核)、sing-box 官方客户端均支持 VLESS+REALITY。

不想暴露 HTTP 订阅端口时，可在 VPS 上本地生成再手动导入：

```bash
set -a && . /etc/vpn-sub.env && set +a
node /opt/vpn-sub/generate.js          # 分享链接
node /opt/vpn-sub/generate.js singbox  # 或 mixed / clash
```

**注意**：订阅走明文 HTTP + 随机路径，token 泄露等于节点泄露。有域名时建议自行套一层 Caddy HTTPS。

## 验证

1. `systemctl status sing-box vpn-sub` 均为 active
2. Tailscale 管理后台出现 `proxy-vps` 且已上线（首次启动即通过 auth key 注册）
3. 客户端导入订阅连接节点后访问 `ip.sb`，显示的应为 **Exit Node 的出口 IP**

## 本地开发

```bash
npm test          # node --test，覆盖订阅生成逻辑
npm run links     # 按当前环境变量打印分享链接
```

## 与旧版（Cloudflare Worker）方案的差异

- 隧道转发由 VPS 上的 sing-box 承担，不再依赖 Cloudflare Worker，无平台封号风险
- 出口 IP 取决于你的 Exit Node，而非 ProxyIP 池
- 入站仅保留 VLESS+REALITY（TCP），移除了 Trojan/Shadowsocks、WS/gRPC/XHTTP 传输、管理后台与 KV 存储
- 订阅生成由 VPS 本地服务完成，不再依赖外部订阅转换 API

## 目录结构

```
server/
  config.template.json   sing-box 服务端配置模板（install.sh 渲染）
  install.sh             一键部署脚本
  sub-server.service     订阅服务 systemd unit 模板
sub/
  generate.js            订阅/链接生成（纯函数 + CLI）
  server.js              极简订阅 HTTP 服务
test/unit/               订阅生成测试
```
