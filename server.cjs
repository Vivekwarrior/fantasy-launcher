'use strict';
/*
 * Web-demo server: serves the same renderer UI as the desktop app and proxies
 * Mojang + Modrinth APIs so the live preview shows REAL data. Game launching
 * itself is simulated in the browser adapter (public/demo.js) — install the
 * desktop app for the real thing.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { getJson } = require('./core/http.cjs');

const ROOT = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

let manifestCache = { at: 0, data: null };
function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') return sendJson(res, { ok: true });

  if (url.pathname === '/api/versions') {
    if (!manifestCache.data || Date.now() - manifestCache.at > 10 * 60 * 1000) {
      const m = await getJson('https://piston-meta.mojang.com/mc/game/version_manifest.json');
      manifestCache = { at: Date.now(), data: m };
    }
    const m = manifestCache.data;
    return sendJson(res, { latest: m.latest, versions: m.versions.filter(v => v.type === 'release').slice(0, 120) });
  }

  if (url.pathname === '/api/modrinth/search') {
    const q = url.searchParams.get('query') || '';
    const loader = url.searchParams.get('loader') || '';
    const version = url.searchParams.get('version') || '';
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const facets = [['project_type:mod']];
    if (loader && loader !== 'vanilla') facets.push([`categories:${loader}`]);
    if (version) facets.push([`versions:${version}`]);
    const apiUrl = `https://api.modrinth.com/v2/search?index=relevance&limit=16&offset=${offset}` +
      `&query=${encodeURIComponent(q)}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
    return sendJson(res, await getJson(apiUrl));
  }

  const mVer = url.pathname.match(/^\/api\/modrinth\/versions\/([A-Za-z0-9]+)$/);
  if (mVer) {
    const loader = url.searchParams.get('loader') || '';
    const gameVersion = url.searchParams.get('gameVersion') || '';
    const qs = [];
    if (loader && loader !== 'vanilla') qs.push(`loaders=${encodeURIComponent(JSON.stringify([loader]))}`);
    if (gameVersion) qs.push(`game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}`);
    const apiUrl = `https://api.modrinth.com/v2/project/${mVer[1]}/version${qs.length ? '?' + qs.join('&') : ''}`;
    return sendJson(res, await getJson(apiUrl));
  }

  return sendJson(res, { error: 'not_found' }, 404);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
  } catch (e) {
    return sendJson(res, { error: String(e.message || e) }, 502);
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(ROOT, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(idx);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`⚔ Fantasy Launcher demo → http://localhost:${PORT}`));
