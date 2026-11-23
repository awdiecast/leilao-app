#!/usr/bin/env node
/*
 * Leilão AW Diecast — versão pública (app standalone, zero dependências).
 * Node >= 18, só módulos nativos (node:http, node:fs, node:path, node:crypto).
 *
 * - Serve o cliente estático (public/), as fotos (uploads/) e a logo (assets/).
 * - API JSON com estado em memória, persistido em state.json ao lado deste arquivo.
 * - Visão do visitante: "/"  ·  Visão do leiloeiro: "/leiloeiro" (com senha).
 *
 * Variáveis de ambiente:
 *   PORT               porta do servidor (padrão 3000)
 *   LEILOERO_PASSWORD  senha do leiloeiro (padrão "aw1234" — TROQUE em produção)
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.LEILOERO_PASSWORD || 'aw1234';
if (!process.env.LEILOERO_PASSWORD) {
  console.warn('[AVISO] LEILOERO_PASSWORD não definida — usando a senha padrão "aw1234". Defina a variável de ambiente antes de usar de verdade!');
}

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const ASSETS_DIR = path.join(ROOT, 'assets');
const STATE_FILE = path.join(ROOT, 'state.json');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/* ------------------------------------------------------------------ estado */

function freshState() {
  return {
    auction: { status: 'draft', lastActivityAt: Date.now() },
    items: [],
    chat: [],
    nextItemNo: 1,
  };
}

let state;
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (!state || !state.auction || !Array.isArray(state.items) || !Array.isArray(state.chat)) {
    state = freshState();
  }
} catch {
  state = freshState();
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), () => {});
  }, 120);
}

const presence = new Map(); // visitorId -> { name, lastSeen }
const sessions = new Set(); // tokens de sessão do leiloeiro

const PRESENCE_WINDOW_MS = 45_000;
const AUTO_CLOSE_MS = 5 * 60 * 1000;
const ANTI_SNIPE_MS = 10_000;

/* --------------------------------------------------------------- utilidades */

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

function liveItem() {
  return state.items.find((i) => i.status === 'live') || null;
}

function queuedItems() {
  return state.items.filter((i) => i.status === 'queued');
}

function touch() {
  state.auction.lastActivityAt = Date.now();
}

function systemChat(body) {
  state.chat.push({ id: uid(), kind: 'system', name: '', body, ts: Date.now() });
  if (state.chat.length > 300) state.chat = state.chat.slice(-300);
}

function publicItem(i) {
  return {
    id: i.id,
    itemNo: i.itemNo,
    photo: i.photo,
    startPrice: i.startPrice,
    increment: i.increment,
    durationSec: i.durationSec,
    status: i.status,
    currentBid: i.currentBid,
    leaderName: i.leaderName,
    endsAt: i.endsAt,
    winnerName: i.winnerName,
    finalPrice: i.finalPrice,
  };
}

function onlineInfo() {
  const now = Date.now();
  const names = [];
  for (const [vid, p] of presence) {
    if (now - p.lastSeen <= PRESENCE_WINDOW_MS) names.push(p.name);
    else presence.delete(vid);
  }
  return { onlineCount: names.length, onlineNames: names };
}

function publicState() {
  const live = liveItem();
  const results = state.items.filter((i) => i.status === 'sold' || i.status === 'nobid');
  const { onlineCount, onlineNames } = onlineInfo();
  return {
    auction: { status: state.auction.status },
    liveItem: live ? publicItem(live) : null,
    lastResult: results.length ? publicItem(results[results.length - 1]) : null,
    queue: queuedItems().map(publicItem),
    results: results.map(publicItem),
    chat: state.chat.slice(-80),
    onlineCount,
    onlineNames,
    nextItemNo: state.nextItemNo,
    serverNow: Date.now(),
  };
}

/* ------------------------------------------------------------ motor do leilão */

function startItem(item) {
  // Um novo item no palco reabre o leilão se ele estava encerrado/rascunho.
  state.auction.status = 'live';
  item.status = 'live';
  item.currentBid = null;
  item.leaderName = null;
  item.leaderVisitorId = null;
  item.winnerName = null;
  item.finalPrice = null;
  item.endsAt = Date.now() + item.durationSec * 1000;
  systemChat(`🔨 No palco: Mini Nº ${item.itemNo} — valendo!`);
  touch();
  save();
}

function resolveLiveItem() {
  const item = liveItem();
  if (!item) return;
  item.endsAt = null;
  if (item.leaderName) {
    item.status = 'sold';
    item.winnerName = item.leaderName;
    item.winnerVisitorId = item.leaderVisitorId;
    item.finalPrice = item.currentBid;
    systemChat(`🏆 Mini Nº ${item.itemNo} — vendida para ${item.winnerName} por ${fmtBRL(item.finalPrice)}!`);
  } else {
    item.status = 'nobid';
    systemChat(`⏱️ Mini Nº ${item.itemNo} — tempo esgotado, sem lances.`);
  }
  touch();
  save();
}

function finishAuction(note) {
  if (liveItem()) resolveLiveItem();
  state.auction.status = 'finished';
  if (note !== false) systemChat('🔒 Leilão encerrado');
  touch();
  save();
}

// Relógio do servidor: encerra item ao zerar e fecha o leilão parado.
setInterval(() => {
  const now = Date.now();
  const live = liveItem();
  if (live && live.endsAt && now >= live.endsAt) resolveLiveItem();
  if (
    state.auction.status === 'live' &&
    !liveItem() &&
    queuedItems().length === 0 &&
    now - state.auction.lastActivityAt > AUTO_CLOSE_MS
  ) {
    state.auction.status = 'finished';
    systemChat('🔒 Leilão encerrado');
    save();
  }
}, 250);

function fmtBRL(v) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
}

/* ------------------------------------------------------------------- http */

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const token = parseCookies(req).leiloeiro_session;
  return token && sessions.has(token);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Não encontrado');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function safeJoin(base, urlPath) {
  const p = path.normalize(path.join(base, urlPath));
  return p.startsWith(base) ? p : null;
}

/* -------------------------------------------------------------------- api */

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/state' && req.method === 'GET') {
    return sendJSON(res, 200, publicState());
  }

  if (p === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.password && body.password === PASSWORD) {
      const token = crypto.randomBytes(24).toString('hex');
      sessions.add(token);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `leiloeiro_session=${token}; HttpOnly; Path=/; SameSite=Lax`,
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    return sendJSON(res, 401, { ok: false, error: 'Senha incorreta' });
  }

  if (p === '/api/logout' && req.method === 'POST') {
    const token = parseCookies(req).leiloeiro_session;
    if (token) sessions.delete(token);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': 'leiloeiro_session=; HttpOnly; Path=/; Max-Age=0',
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (p === '/api/me' && req.method === 'GET') {
    return sendJSON(res, 200, { authed: isAuthed(req) });
  }

  if (p === '/api/presence' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    const visitorId = String(body.visitorId || '').slice(0, 80);
    if (!visitorId || !name) return sendJSON(res, 400, { ok: false, error: 'visitorId e name obrigatórios' });
    presence.set(visitorId, { name, lastSeen: Date.now() });
    const { onlineCount } = onlineInfo();
    return sendJSON(res, 200, { ok: true, onlineCount });
  }

  if (p === '/api/chat' && req.method === 'POST') {
    const body = await readBody(req);
    const text = String(body.body || '').trim().slice(0, 300);
    let name = String(body.name || '').trim().slice(0, 40);
    if (!text) return sendJSON(res, 400, { ok: false, error: 'Mensagem vazia' });
    if (!name) {
      if (isAuthed(req)) name = 'Leiloeiro';
      else return sendJSON(res, 400, { ok: false, error: 'Falta o nome' });
    }
    state.chat.push({ id: uid(), kind: 'user', name, body: text, ts: Date.now() });
    if (state.chat.length > 300) state.chat = state.chat.slice(-300);
    save();
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/bid' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    const visitorId = String(body.visitorId || '').slice(0, 80);
    if (!name) return sendJSON(res, 400, { ok: false, error: 'Falta o nome pra dar lance' });
    const item = liveItem();
    if (!item || state.auction.status !== 'live') {
      return sendJSON(res, 409, { ok: false, error: 'Nenhuma mini ao vivo agora' });
    }
    const now = Date.now();
    if (item.endsAt && now >= item.endsAt) {
      resolveLiveItem();
      return sendJSON(res, 409, { ok: false, error: 'O tempo dessa mini acabou' });
    }
    item.currentBid = item.currentBid == null ? item.startPrice : item.currentBid + item.increment;
    item.leaderName = name;
    item.leaderVisitorId = visitorId || null;
    // Anti-snipe: lance nos últimos 10s devolve o relógio pra 10s.
    if (item.endsAt && item.endsAt - now < ANTI_SNIPE_MS) item.endsAt = now + ANTI_SNIPE_MS;
    touch();
    save();
    return sendJSON(res, 200, { ok: true, currentBid: item.currentBid, leaderName: item.leaderName });
  }

  /* ---------------------------------------------------------- leiloeiro */

  const organizerRoutes = [
    '/api/items',
    '/api/items/reorder',
    '/api/next',
    '/api/stage/end',
    '/api/auction/finish',
  ];
  const isItemAction = /^\/api\/items\/[a-z0-9]+\/(start|remove|requeue)$/.test(p);
  if (organizerRoutes.includes(p) || isItemAction) {
    if (!isAuthed(req)) return sendJSON(res, 401, { ok: false, error: 'Não autorizado — faça login em /leiloeiro' });
  } else if (p.startsWith('/api/')) {
    return sendJSON(res, 404, { ok: false, error: 'Rota não encontrada' });
  }

  if (p === '/api/items' && req.method === 'POST') {
    const body = await readBody(req);
    let photo = '';
    if (body.photoDataUrl) {
      const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(body.photoDataUrl);
      if (!m) return sendJSON(res, 400, { ok: false, error: 'Foto inválida' });
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const fname = `mini-${state.nextItemNo}-${uid()}.${ext}`;
      try {
        fs.writeFileSync(path.join(UPLOADS_DIR, fname), Buffer.from(m[2], 'base64'));
        photo = `/uploads/${fname}`;
      } catch {
        // Disco somente-leitura (ex.: Deno Deploy): guarda a foto embutida no item.
        photo = body.photoDataUrl;
      }
    } else if (body.photo) {
      photo = String(body.photo);
    }
    if (!photo) return sendJSON(res, 400, { ok: false, error: 'A foto é obrigatória' });
    const startPrice = Math.max(0, Number(body.startPrice) || 0);
    const increment = Math.max(0.5, Number(body.increment) || 1);
    const durationSec = [10, 15, 30].includes(Number(body.durationSec)) ? Number(body.durationSec) : 15;
    const item = {
      id: uid(),
      itemNo: state.nextItemNo++,
      photo,
      startPrice,
      increment,
      durationSec,
      status: 'queued',
      currentBid: null,
      leaderName: null,
      leaderVisitorId: null,
      winnerName: null,
      winnerVisitorId: null,
      finalPrice: null,
      endsAt: null,
    };
    state.items.push(item);
    touch();
    save();
    if (body.startNow) {
      if (liveItem()) resolveLiveItem();
      startItem(item);
    }
    return sendJSON(res, 200, { ok: true, item: publicItem(item) });
  }

  if (p === '/api/items/reorder' && req.method === 'POST') {
    const body = await readBody(req);
    const order = Array.isArray(body.order) ? body.order.map(String) : [];
    const queued = queuedItems();
    const byId = new Map(queued.map((i) => [i.id, i]));
    const reordered = order.map((id) => byId.get(id)).filter(Boolean);
    for (const i of queued) if (!reordered.includes(i)) reordered.push(i);
    let q = 0;
    state.items = state.items.map((i) => (i.status === 'queued' ? reordered[q++] : i));
    save();
    return sendJSON(res, 200, { ok: true });
  }

  const actionMatch = /^\/api\/items\/([a-z0-9]+)\/(start|remove|requeue)$/.exec(p);
  if (actionMatch && req.method === 'POST') {
    const item = state.items.find((i) => i.id === actionMatch[1]);
    if (!item) return sendJSON(res, 404, { ok: false, error: 'Mini não encontrada' });
    const action = actionMatch[2];

    if (action === 'remove') {
      if (item.status === 'live') return sendJSON(res, 409, { ok: false, error: 'Mini ao vivo não pode ser removida' });
      state.items = state.items.filter((i) => i.id !== item.id);
      save();
      return sendJSON(res, 200, { ok: true });
    }

    if (action === 'start') {
      if (item.status !== 'queued') return sendJSON(res, 409, { ok: false, error: 'Essa mini não está na fila' });
      if (liveItem()) resolveLiveItem();
      startItem(item);
      return sendJSON(res, 200, { ok: true, item: publicItem(item) });
    }

    if (action === 'requeue') {
      if (item.status !== 'sold' && item.status !== 'nobid') {
        return sendJSON(res, 409, { ok: false, error: 'Só dá pra refazer mini já encerrada' });
      }
      item.currentBid = null;
      item.leaderName = null;
      item.leaderVisitorId = null;
      item.winnerName = null;
      item.winnerVisitorId = null;
      item.finalPrice = null;
      item.endsAt = null;
      if (!liveItem()) {
        // Palco livre: volta AO VIVO na hora, com relógio novo.
        state.auction.status = 'live';
        item.status = 'live';
        item.endsAt = Date.now() + item.durationSec * 1000;
        systemChat(`🔨 De volta ao palco: Mini Nº ${item.itemNo} — valendo de novo!`);
        touch();
        save();
        return sendJSON(res, 200, { ok: true, mode: 'live', item: publicItem(item) });
      }
      // Palco ocupado: vai pra frente da fila.
      item.status = 'queued';
      state.items = state.items.filter((i) => i.id !== item.id);
      const firstQueuedIdx = state.items.findIndex((i) => i.status === 'queued');
      if (firstQueuedIdx === -1) state.items.push(item);
      else state.items.splice(firstQueuedIdx, 0, item);
      touch();
      save();
      return sendJSON(res, 200, { ok: true, mode: 'queued', item: publicItem(item) });
    }
  }

  if (p === '/api/next' && req.method === 'POST') {
    if (liveItem()) return sendJSON(res, 409, { ok: false, error: 'Já tem uma mini no palco' });
    const next = queuedItems()[0];
    if (!next) return sendJSON(res, 409, { ok: false, error: 'A fila está vazia' });
    startItem(next);
    return sendJSON(res, 200, { ok: true, item: publicItem(next) });
  }

  if (p === '/api/stage/end' && req.method === 'POST') {
    if (!liveItem()) return sendJSON(res, 409, { ok: false, error: 'Nenhuma mini no palco' });
    resolveLiveItem();
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/auction/finish' && req.method === 'POST') {
    finishAuction();
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { ok: false, error: 'Rota não encontrada' });
}

/* ---------------------------------------------------------------- servidor */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    if (p.startsWith('/api/')) return await handleApi(req, res, url);

    if (p === '/' || p === '/index.html') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    if (p === '/leiloeiro' || p === '/leiloeiro.html') return serveFile(res, path.join(PUBLIC_DIR, 'leiloeiro.html'));

    if (p.startsWith('/uploads/')) {
      const fp = safeJoin(UPLOADS_DIR, p.slice('/uploads/'.length));
      if (!fp) { res.writeHead(400); return res.end('bad path'); }
      return serveFile(res, fp);
    }
    if (p.startsWith('/assets/')) {
      const fp = safeJoin(ASSETS_DIR, p.slice('/assets/'.length));
      if (!fp) { res.writeHead(400); return res.end('bad path'); }
      return serveFile(res, fp);
    }
    const fp = safeJoin(PUBLIC_DIR, p.slice(1));
    if (fp && fs.existsSync(fp) && fs.statSync(fp).isFile()) return serveFile(res, fp);

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Não encontrado');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJSON(res, 500, { ok: false, error: 'Erro interno' });
  }
});

server.listen(PORT, () => {
  console.log(`Leilão AW Diecast rodando em http://localhost:${PORT}`);
  console.log(`  Visitante:  http://localhost:${PORT}/`);
  console.log(`  Leiloeiro:  http://localhost:${PORT}/leiloeiro`);
});
