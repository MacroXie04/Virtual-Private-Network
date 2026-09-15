/**
 * Same-origin stylesheet for the administration UI.
 * Served at ADMIN_STYLES_PATH; permitted by CSP style-src 'self'.
 * No scripts, no external assets: system fonts and inline SVG only.
 */
export const ADMIN_STYLES_PATH = '/assets/admin.css';

export const ADMIN_STYLES = `:root {
  --bg: #eef1f6;
  --surface: #ffffff;
  --border: #d8dfe9;
  --border-strong: #b6c0cf;
  --text: #17202e;
  --muted: #4d5a6b;
  --primary: #1d4ed8;
  --primary-hover: #1e40af;
  --primary-soft: #e8effc;
  --danger: #b42318;
  --danger-hover: #8f1d13;
  --danger-soft: #fee4e2;
  --danger-border: #f1b8b2;
  --ok: #067647;
  --ok-soft: #dcfae6;
  --ok-border: #a6e9c5;
  --warn: #93370d;
  --warn-soft: #fef0c7;
  --warn-border: #f5d39a;
  --radius: 10px;
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.08);
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, "Liberation Mono", monospace;
}
* { box-sizing: border-box; }
html { color-scheme: light; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.65 -apple-system, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; }
code, pre { font-family: var(--mono); font-size: 0.92em; }
h1, h2, h3 { line-height: 1.35; }
p { margin: 0 0 10px; }
a { color: var(--primary); }
:focus-visible { outline: 3px solid rgba(29, 78, 216, 0.55); outline-offset: 2px; border-radius: 4px; }
.skip-link { position: absolute; left: -9999px; top: 0; z-index: 100; background: var(--surface); padding: 8px 14px; border-radius: 8px; box-shadow: var(--shadow); }
.skip-link:focus { left: 10px; top: 10px; }
.topbar { position: sticky; top: 0; z-index: 10; background: var(--surface); border-bottom: 1px solid var(--border); }
.topbar-inner { max-width: 1080px; margin: 0 auto; padding: 10px 20px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.brand { display: inline-flex; align-items: center; gap: 9px; margin: 0; font-size: 16px; font-weight: 700; }
.nav { display: flex; gap: 2px; flex: 1; }
.nav a { padding: 6px 12px; border-radius: 8px; color: var(--muted); text-decoration: none; font-weight: 600; }
.nav a:hover, .nav a[aria-current="page"] { color: var(--primary); background: var(--primary-soft); }
.logout { margin: 0; }
.topbar .whoami { flex: 1; margin: 0; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 22px 20px 56px; display: grid; gap: 18px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 18px 20px; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.card h2 { margin: 0; font-size: 17px; }
.card h3 { margin: 0; font-size: 15.5px; overflow-wrap: anywhere; }
.section-title { margin: 26px 2px 12px; font-size: 13px; font-weight: 700; color: var(--muted); letter-spacing: 0.04em; }
.card .section-title { margin: 22px 0 10px; font-size: 13px; }
.banner { display: flex; gap: 10px; align-items: flex-start; border: 1px solid; border-radius: var(--radius); padding: 12px 16px; margin: 0; font-weight: 500; }
.banner svg { flex: none; margin-top: 2px; }
.banner-ok { background: var(--ok-soft); border-color: var(--ok-border); color: var(--ok); }
.banner-warn { background: var(--warn-soft); border-color: var(--warn-border); color: var(--warn); }
.alert { background: var(--danger-soft); border: 1px solid var(--danger-border); color: var(--danger); border-radius: 8px; padding: 10px 12px; font-weight: 500; }
.muted { color: var(--muted); }
.meta { margin: 0; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 600; white-space: nowrap; }
.badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.badge-ok { color: var(--ok); background: var(--ok-soft); }
.badge-warn { color: var(--warn); background: var(--warn-soft); }
.badge-off { color: #475467; background: #edf1f5; }
.badge-revoked { color: var(--danger); background: var(--danger-soft); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 6px 14px; border: 1px solid transparent; border-radius: 8px; font: inherit; font-weight: 600; line-height: 1.4; text-decoration: none; cursor: pointer; background: none; color: var(--text); }
.btn-primary { background: var(--primary); color: #ffffff; }
.btn-primary:hover:not(:disabled) { background: var(--primary-hover); }
.btn-secondary { background: var(--surface); border-color: var(--border-strong); }
.btn-secondary:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); background: var(--primary-soft); }
.btn-danger { background: var(--danger); color: #ffffff; }
.btn-danger:hover:not(:disabled) { background: var(--danger-hover); }
.btn-danger-ghost { background: var(--surface); border-color: var(--danger-border); color: var(--danger); }
.btn-danger-ghost:hover:not(:disabled) { background: var(--danger-soft); }
.btn-ghost { color: var(--muted); }
.btn-ghost:hover:not(:disabled) { color: var(--primary); background: var(--primary-soft); }
.btn:disabled, select:disabled { cursor: not-allowed; opacity: 0.55; }
.btn-block { width: 100%; }
form { margin: 0; }
.field { display: grid; gap: 6px; font-weight: 600; }
.field .hint { font-weight: 400; font-size: 12.5px; color: var(--muted); }
input[type="text"], input[type="password"], input:not([type]), select { min-height: 38px; max-width: 100%; padding: 6px 10px; border: 1px solid var(--border-strong); border-radius: 8px; font: inherit; background: var(--surface); color: var(--text); }
input:focus-visible, select:focus-visible { outline: 2px solid var(--primary); outline-offset: 0; border-color: var(--primary); }
.field-error { display: none; margin: 0; font-size: 12.5px; font-weight: 500; color: var(--danger); }
input[aria-invalid="true"] { border-color: var(--danger); }
input[aria-invalid="true"] ~ .field-error { display: block; }
input:user-invalid { border-color: var(--danger); }
input:user-invalid ~ .field-error { display: block; }
.form-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
.form-stack { display: grid; gap: 12px; max-width: 420px; }
.form-row .field { flex: 1 1 220px; }
.kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px 28px; margin: 0; }
.kv div { min-width: 0; }
.kv dt { color: var(--muted); font-size: 12.5px; font-weight: 600; }
.kv dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.user-list { list-style: none; margin: 0; padding: 0; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.user-row { display: grid; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--border); }
.user-row:first-child { border-top: 0; }
.user-main { display: grid; gap: 4px; min-width: 0; }
.user-identity { display: flex; align-items: center; gap: 6px 14px; flex-wrap: wrap; }
.user-identity h3 { margin: 0; font-size: 15.5px; overflow-wrap: anywhere; }
.user-identity .meta { flex: 1 1 280px; min-width: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.actions form { display: inline-flex; }
.rename summary { cursor: pointer; color: var(--primary); font-weight: 600; width: fit-content; }
.rename form { margin-top: 10px; }
.usage { font-variant-numeric: tabular-nums; }
.danger { border-top: 1px dashed var(--border); padding-top: 10px; }
.danger summary { cursor: pointer; color: var(--danger); font-weight: 600; width: fit-content; }
.danger form { display: grid; gap: 10px; margin-top: 10px; }
.danger .hint { margin: 0; color: var(--muted); font-size: 12.5px; }
.exit-list { list-style: none; margin: 0 0 14px; padding: 0; display: grid; gap: 10px; }
.exit-item { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.exit-item p { margin: 0; }
.exit-item strong { overflow-wrap: anywhere; }
.exit-item code { color: var(--muted); }
.empty { border: 1px dashed var(--border-strong); border-radius: 8px; padding: 16px; color: var(--muted); background: #fafcff; margin: 0 0 12px; }
.auth-wrap { min-height: 100dvh; display: grid; place-items: center; grid-template-columns: minmax(0, 1fr); padding: 24px 16px; }
.auth-inner { width: 100%; max-width: 400px; }
.auth-card { width: 100%; max-width: 400px; margin: 0; }
.auth-card { padding: 24px; text-align: center; }
.auth-card .brand { font-size: 18px; }
.auth-card .alert { margin-top: 16px; text-align: left; }
.auth-card form { display: grid; gap: 14px; margin-top: 20px; text-align: left; }
.auth-card .field > span:not(.field-error) { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.auth-inner-wide { max-width: 600px; display: grid; gap: 18px; }
.auth-inner-wide > .meta { text-align: center; }
.home-hero { text-align: center; padding: 28px 24px; }
.home-hero .brand { font-size: 20px; }
.home-hero .actions { justify-content: center; margin: 18px 0 0; }
.steps { margin: 0; padding-left: 22px; display: grid; gap: 8px; }
.secret-list { margin: 0 0 16px; }
.secret-list div { margin-bottom: 16px; }
.secret-list dt { font-weight: 700; }
.secret-list dd { margin: 4px 0 0; }
.copy { margin: 0; padding: 10px 12px; background: #101828; color: #d7e3ff; border-radius: 8px; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-all; }
@media (max-width: 720px) {
  .topbar-inner { gap: 10px; padding: 8px 14px; }
  .nav { order: 3; flex: 1 1 100%; }
  .wrap { padding: 16px 14px 44px; }
  .card { padding: 14px 16px; }
  .kv { grid-template-columns: 1fr; }
  .user-row { padding: 12px 16px; }
}
`;
