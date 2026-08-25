import { buildShareLinks } from './generate.js';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// base: public base URL of the subscription service, e.g. http://203.0.113.10:8080/<token>
// tsState: { service, exitNode, hasAuthKey, maskedAuthKey, hostname, exitNodes, logs, flash, error }
export function buildPage(cfg, base, tsState = {}) {
  const link = buildShareLinks(cfg)[0];
  const subs = [
    ['Generic (mixed)', `${base}`],
    ['sing-box', `${base}/singbox`],
    ['Clash Meta', `${base}/clash`],
  ];

  const rows = [
    ['Address', cfg.host],
    ['Port', cfg.port],
    ['UUID', cfg.uuid],
    ['Protocol', 'VLESS + REALITY (xtls-rprx-vision)'],
    ['SNI', cfg.serverName],
    ['Public Key', cfg.publicKey],
    ['Short ID', cfg.shortId],
  ].map(([k, v]) => `<tr><td>${esc(k)}</td><td><code>${esc(v)}</code></td></tr>`).join('\n        ');

  const subItems = subs.map(([label, url]) => `
      <div class="sub-row">
        <span class="sub-label">${esc(label)}</span>
        <code class="sub-url">${esc(url)}</code>
        <button class="copy" data-copy="${esc(url)}">Copy</button>
      </div>`).join('');

  const flash = tsState.flash
    ? (tsState.flash === 'ok'
      ? '<p class="flash ok">Saved. sing-box has been restarted.</p>'
      : `<p class="flash err">Operation failed: ${esc(tsState.flash.replace(/^err:/, ''))}</p>`)
    : '';

  const tsRows = [
    ['sing-box Service', tsState.service],
    ['Current Exit Node', tsState.exitNode],
    ['Auth Key', tsState.hasAuthKey ? tsState.maskedAuthKey : 'Not configured'],
    ['tsnet Hostname', tsState.hostname],
  ].filter(([, v]) => v)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td><code>${esc(v)}</code></td></tr>`)
    .join('\n        ');

  const exitNodeOptions = (tsState.exitNodes ?? [])
    .map((n) => `<option value="${esc(n.ip)}" label="${esc(n.name)}"></option>`)
    .join('');

  const tsError = tsState.error ? `<p class="flash err">${esc(tsState.error)}</p>` : '';
  const tsLogs = tsState.logs ? `<pre class="logs">${esc(tsState.logs)}</pre>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(cfg.name)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1rem;
    font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
    background: #0f1115; color: #e6e6e6;
    display: flex; justify-content: center;
  }
  main { width: 100%; max-width: 640px; }
  h1 { font-size: 1.4rem; margin: 0 0 1.5rem; }
  h2 { font-size: 1rem; color: #9aa0aa; margin: 0 0 .75rem; font-weight: 600; }
  .card {
    background: #1a1d24; border: 1px solid #2a2e37;
    border-radius: 12px; padding: 1.25rem; margin-bottom: 1.25rem;
  }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  td { padding: .4rem 0; vertical-align: top; word-break: break-all; }
  td:first-child { color: #9aa0aa; width: 6.5rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  .qr-box { display: flex; gap: 1.25rem; align-items: flex-start; flex-wrap: wrap; }
  #qr { background: #fff; padding: .75rem; border-radius: 8px; min-width: 164px; min-height: 164px; }
  .link-text {
    flex: 1; min-width: 220px; word-break: break-all;
    background: #12141a; border-radius: 8px; padding: .75rem; font-size: .8rem;
  }
  button {
    cursor: pointer; border: 1px solid #3a4150; border-radius: 8px;
    background: #232836; color: #e6e6e6; padding: .45rem .9rem; font-size: .85rem;
  }
  button:hover { background: #2c3242; }
  .sub-row { display: flex; gap: .6rem; align-items: center; margin: .5rem 0; flex-wrap: wrap; }
  .sub-label { width: 6.5rem; color: #9aa0aa; font-size: .9rem; }
  .sub-url { flex: 1; min-width: 200px; word-break: break-all; font-size: .8rem; }
  .downloads { display: flex; gap: .6rem; flex-wrap: wrap; }
  .downloads a {
    text-decoration: none; color: #7ab8ff; border: 1px solid #2c3a4d;
    border-radius: 8px; padding: .45rem .9rem; font-size: .85rem;
  }
  .downloads a:hover { background: #1b2230; }
  .warn { color: #c9a35c; font-size: .8rem; margin-top: .75rem; }
  .flash { border-radius: 8px; padding: .6rem .9rem; font-size: .85rem; margin: 0 0 1rem; }
  .flash.ok { background: #16321f; border: 1px solid #2a5a3a; color: #7fd4a0; }
  .flash.err { background: #3a1d1d; border: 1px solid #6b2f2f; color: #f0a0a0; }
  .form-row { display: flex; gap: .6rem; align-items: center; margin: .6rem 0; flex-wrap: wrap; }
  .form-row label { width: 6.5rem; color: #9aa0aa; font-size: .9rem; }
  .form-row input {
    flex: 1; min-width: 200px; background: #12141a; border: 1px solid #3a4150;
    border-radius: 8px; color: #e6e6e6; padding: .45rem .9rem; font-size: .85rem;
  }
  .hint { color: #9aa0aa; font-size: .8rem; margin-left: .6rem; }
  pre.logs {
    background: #12141a; border-radius: 8px; padding: .75rem; font-size: .75rem;
    max-height: 16rem; overflow: auto; white-space: pre-wrap; word-break: break-all;
  }
</style>
</head>
<body>
<main>
  <h1>${esc(cfg.name)}</h1>

  <section class="card">
    <h2>Node Info</h2>
    <table>
        ${rows}
    </table>
  </section>

  <section class="card">
    <h2>Share Link</h2>
    <div class="qr-box">
      <div id="qr"></div>
      <div class="link-text"><code>${esc(link)}</code></div>
    </div>
    <p><button class="copy" data-copy="${esc(link)}">Copy Link</button></p>
  </section>

  <section class="card">
    <h2>Tailscale Exit</h2>
    ${flash}
    ${tsError}
    <table>
        ${tsRows}
    </table>
    <form method="post" action="${esc(base)}/tailscale" style="margin-top:1rem">
      <div class="form-row">
        <label for="authKey">Auth Key</label>
        <input type="password" id="authKey" name="authKey" placeholder="Leave blank to keep unchanged" autocomplete="off">
      </div>
      <div class="form-row">
        <label for="exitNode">Exit Node</label>
        <input id="exitNode" name="exitNode" list="exit-nodes" required
               placeholder="100.x.x.x or machine name" value="${esc(tsState.exitNode ?? '')}">
        <datalist id="exit-nodes">${exitNodeOptions}</datalist>
      </div>
      <button type="submit">Save &amp; restart sing-box</button>
      <span class="hint">Saving restarts sing-box; the proxy is interrupted for a few seconds.</span>
    </form>
    ${tsLogs}
  </section>

  <section class="card">
    <h2>Subscription URLs</h2>
    ${subItems}
    <div class="downloads" style="margin-top:1rem">
      <a href="${esc(base)}/singbox" download="singbox-config.json">Download sing-box config</a>
      <a href="${esc(base)}/clash" download="clash-config.yaml">Download Clash Meta config</a>
    </div>
    <p class="warn">This page and the subscription URLs contain full node credentials. Do not share them publicly.</p>
  </section>
</main>
<script src="https://cdn.jsdelivr.net/gh/davidshimjs/qrcodejs/qrcode.min.js"></script>
<script>
  document.querySelectorAll('button.copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  });
  if (window.QRCode) {
    new QRCode(document.getElementById('qr'), {
      text: ${JSON.stringify(link)},
      width: 164,
      height: 164,
      correctLevel: QRCode.CorrectLevel.M,
    });
  } else {
    document.getElementById('qr').style.display = 'none';
  }
</script>
</body>
</html>
`;
}
