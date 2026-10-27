import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const TYPES = {
  '.js': 'application/javascript', '.mjs': 'application/javascript', '.json': 'application/json',
  '.html': 'text/html', '.css': 'text/css', '.txt': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.ttf': 'font/ttf',
  '.astc': 'application/octet-stream', '.bin': 'application/octet-stream', '.pkm': 'application/octet-stream',
  '.pvr': 'application/octet-stream', '.fnt': 'application/octet-stream',
};
function contentType(p) {
  const ext = path.extname(p).toLowerCase();
  return TYPES[ext] || 'application/octet-stream';
}

const memoryStore = {
  roles: {},
  users: {},
  userMails: {},
  globalMails: []
};

function handler(req, res) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const urlObj = new URL(req.url, 'http://localhost:8123');
  const pathname = decodeURIComponent(urlObj.pathname);

  // favicon
  if (pathname === '/favicon.ico') { res.writeHead(204, cors); res.end(); return; }

  // /api/sync
  if (pathname === '/api/sync') {
    if (req.method === 'GET') {
      const uid = (urlObj.searchParams.get('uid') || '').trim();
      const roleData = memoryStore.roles[uid] || null;
      const userMails = memoryStore.userMails[uid] || [];
      const newMails = [...userMails, ...memoryStore.globalMails];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
      res.end(JSON.stringify({ ok: true, uid, roleData, newMails, serverTime: Math.floor(Date.now() / 1000) }));
      return;
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const json = JSON.parse(body);
          const uid = (json.uid || '').trim();
          if (uid && json.roleData) {
            memoryStore.roles[uid] = typeof json.roleData === 'string' ? json.roleData : JSON.stringify(json.roleData);
            memoryStore.users[uid] = { uid, updatedAt: Date.now(), ...(json.summary || {}) };
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...cors });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
  }

  // /api/mail
  if (pathname === '/api/mail') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
    res.end(JSON.stringify({ ok: true, mails: [] }));
    return;
  }

  // 微信临时下载图片兜底
  if (pathname.startsWith('/tmp/dl_')) {
    const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache', ...cors });
    res.end(transparentPng);
    return;
  }

  // 静态文件
  let relPath = pathname.replace(/^\//, '');
  if (!relPath) relPath = 'index.html';
  const localPath = path.join(ROOT, relPath);

  if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
    const buf = fs.readFileSync(localPath);
    const headers = { 'Content-Type': contentType(localPath), 'Content-Length': buf.length, ...cors };
    if (localPath.endsWith('.js') || localPath.endsWith('.html') || localPath.endsWith('.json')) {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    }
    res.writeHead(200, headers);
    res.end(buf);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain', ...cors });
  res.end('not found: ' + pathname);
}

const server = http.createServer(handler);
server.listen(8123, () => {
  console.log('Local cloudflare-deploy test server listening on http://localhost:8123');
});
