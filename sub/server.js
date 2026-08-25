import http from 'node:http';
import {
  fromEnv,
  buildMixed,
  buildSingboxConfig,
  buildClashConfig,
  buildShareLinks,
} from './generate.js';

const token = process.env.SUB_TOKEN;
if (!token) {
  console.error('缺少环境变量 SUB_TOKEN');
  process.exit(1);
}

const cfg = fromEnv();
const listenPort = Number(process.env.LISTEN_PORT ?? 8080);

const handlers = {
  mixed: {
    contentType: 'text/plain; charset=utf-8',
    body: () => buildMixed(cfg),
  },
  singbox: {
    contentType: 'application/json; charset=utf-8',
    body: () => JSON.stringify(buildSingboxConfig(cfg), null, 2),
  },
  clash: {
    contentType: 'text/yaml; charset=utf-8',
    body: () => buildClashConfig(cfg),
  },
  links: {
    contentType: 'text/plain; charset=utf-8',
    body: () => buildShareLinks(cfg).join('\n') + '\n',
  },
};

function sniffFormat(ua) {
  const s = String(ua ?? '').toLowerCase();
  if (s.includes('sing-box') || s.includes('singbox')) return 'singbox';
  if (s.includes('clash')) return 'clash';
  return 'mixed';
}

const server = http.createServer((req, res) => {
  const notFound = () => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  };

  if (req.method !== 'GET') return notFound();

  const parts = new URL(req.url ?? '/', 'http://localhost').pathname.split('/').filter(Boolean);
  if (parts.length < 1 || parts.length > 2 || parts[0] !== token) return notFound();

  const format = parts[1] ?? sniffFormat(req.headers['user-agent']);
  const handler = handlers[format];
  if (!handler) return notFound();

  res.writeHead(200, { 'content-type': handler.contentType });
  res.end(handler.body());
});

server.listen(listenPort, () => {
  console.log(`subscription server listening on :${listenPort}`);
});
