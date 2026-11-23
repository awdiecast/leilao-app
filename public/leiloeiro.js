/* Leilão AW Diecast — painel do leiloeiro */
'use strict';

const $ = (id) => document.getElementById(id);
const fmt = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = null;
let serverOffset = 0;
let photoDataUrl = null;
let selPrice = 2, selInc = 1, selDur = 15;

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Erro ${r.status}`);
  return data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

/* ------------------------------------------------------------------ login */

async function checkAuth() {
  try {
    const me = await api('/api/me');
    if (me.authed) {
      $('loginBox').classList.add('hidden');
      $('panel').classList.remove('hidden');
      fetchState();
    } else {
      $('loginBox').classList.remove('hidden');
      $('panel').classList.add('hidden');
    }
  } catch {
    $('loginBox').classList.remove('hidden');
  }
}

async function doLogin() {
  try {
    await post('/api/login', { password: $('loginPassword').value });
    $('loginError').textContent = '';
    checkAuth();
  } catch (err) {
    $('loginError').textContent = err.message;
  }
}
$('loginBtn').addEventListener('click', doLogin);
$('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('logoutBtn').addEventListener('click', async () => { await post('/api/logout'); location.reload(); });

/* -------------------------------------------------------------- formulário */

$('photoDrop').addEventListener('click', () => $('photoInput').click());
$('photoInput').addEventListener('change', () => {
  const f = $('photoInput').files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    photoDataUrl = reader.result;
    $('photoPreview').src = photoDataUrl;
    $('photoPreview').classList.remove('hidden');
    $('photoDropText').classList.add('hidden');
  };
  reader.readAsDataURL(f);
});

function chipGroup(elId, attr, cb) {
  $(elId).querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $(elId).querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
      chip.classList.add('on');
      cb(Number(chip.dataset[attr]));
    });
  });
}
chipGroup('priceChips', 'price', (v) => { selPrice = v; $('priceInput').value = ''; });
chipGroup('incChips', 'inc', (v) => { selInc = v; });
chipGroup('durChips', 'dur', (v) => { selDur = v; });
$('priceInput').addEventListener('input', () => {
  const v = Number($('priceInput').value);
  if (v > 0) {
    selPrice = v;
    $('priceChips').querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
  }
});
// Seleções padrão visíveis
document.querySelector('#priceChips .chip[data-price="2"]').classList.add('on');
document.querySelector('#incChips .chip[data-inc="1"]').classList.add('on');
document.querySelector('#durChips .chip[data-dur="15"]').classList.add('on');

async function submitItem(startNow) {
  $('formError').textContent = '';
  if (!photoDataUrl) { $('formError').textContent = 'Escolha a foto da cartela primeiro'; return; }
  try {
    await post('/api/items', {
      photoDataUrl, startPrice: selPrice, increment: selInc, durationSec: selDur, startNow,
    });
    photoDataUrl = null;
    $('photoPreview').classList.add('hidden');
    $('photoDropText').classList.remove('hidden');
    $('photoInput').value = '';
    fetchState();
    if (startNow) scrollToMonitor();
  } catch (err) {
    $('formError').textContent = err.message;
  }
}
$('startNowBtn').addEventListener('click', () => submitItem(true));
$('enqueueBtn').addEventListener('click', () => submitItem(false));

function scrollToMonitor() {
  $('monitorPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ----------------------------------------------------------------- ações */

$('endStageBtn').addEventListener('click', async () => {
  try { await post('/api/stage/end'); $('monitorError').textContent = ''; fetchState(); }
  catch (err) { $('monitorError').textContent = err.message; }
});
$('nextBtn').addEventListener('click', async () => {
  try { await post('/api/next'); $('monitorError').textContent = ''; fetchState(); scrollToMonitor(); }
  catch (err) { $('monitorError').textContent = err.message; }
});
$('finishBtn').addEventListener('click', async () => {
  try { await post('/api/auction/finish'); $('monitorError').textContent = ''; fetchState(); }
  catch (err) { $('monitorError').textContent = err.message; }
});

async function queueAction(id, action) {
  try {
    const data = await post(`/api/items/${id}/${action}`);
    fetchState();
    if (action === 'requeue') scrollToMonitor();
    return data;
  } catch (err) {
    $('monitorError').textContent = err.message;
  }
}

async function moveInQueue(id, dir) {
  if (!S) return;
  const ids = S.queue.map((i) => i.id);
  const idx = ids.indexOf(id);
  const swap = idx + dir;
  if (idx < 0 || swap < 0 || swap >= ids.length) return;
  [ids[idx], ids[swap]] = [ids[swap], ids[idx]];
  try { await post('/api/items/reorder', { order: ids }); fetchState(); } catch {}
}

/* ------------------------------------------------------------------- chat */

$('orgChatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('orgChatInput').value.trim();
  if (!text) return;
  try {
    await post('/api/chat', { body: text }); // sem nome → servidor usa "Leiloeiro"
    $('orgChatInput').value = '';
    $('orgChatError').textContent = '';
    fetchState();
  } catch (err) {
    $('orgChatError').textContent = err.message;
  }
});

/* ------------------------------------------------------------- renderização */

function tickMonitor() {
  const cd = $('monCountdown');
  if (S && S.liveItem && S.liveItem.endsAt) {
    const secs = Math.max(0, Math.ceil((S.liveItem.endsAt - (Date.now() + serverOffset)) / 1000));
    cd.textContent = secs + 's';
    cd.classList.toggle('low', secs <= 5);
  }
}
setInterval(tickMonitor, 200);

function render() {
  if (!S) return;
  $('orgOnlineCount').textContent = S.onlineCount;
  $('orgOnlineNames').textContent = S.onlineNames.length ? 'Online: ' + S.onlineNames.join(', ') : '';
  $('nextNoLabel').textContent = `Mini Nº ${S.nextItemNo}`;

  const live = S.liveItem;
  if (live) {
    $('monPhoto').src = live.photo;
    $('monPhoto').classList.remove('hidden');
    $('monEmpty').classList.add('hidden');
    $('monCountdown').classList.remove('hidden');
    const price = live.currentBid == null ? live.startPrice : live.currentBid;
    $('monInfo').innerHTML =
      `<span>Mini Nº <b>${live.itemNo}</b></span>` +
      `<span>Lance atual: <b>${fmt(price)}</b></span>` +
      `<span>Líder: <b>${live.leaderName ? esc(live.leaderName) : '—'}</b></span>` +
      `<span>Status: <b>${S.auction.status}</b></span>`;
    tickMonitor();
  } else {
    $('monPhoto').classList.add('hidden');
    $('monEmpty').classList.remove('hidden');
    $('monCountdown').classList.add('hidden');
    $('monInfo').innerHTML = `<span>Status do leilão: <b>${S.auction.status}</b></span><span>Fila: <b>${S.queue.length}</b></span>`;
  }

  // Fila
  $('queueCount').textContent = S.queue.length;
  $('queueList').innerHTML = S.queue.length ? S.queue.map((i, idx) =>
    `<div class="list-row"><img src="${i.photo}" alt=""><div class="grow"><b>Mini Nº ${i.itemNo}</b><div class="small">Começa ${fmt(i.startPrice)} · sobe ${fmt(i.increment)} · ${i.durationSec}s</div></div>` +
    `<button class="btn mini-btn" data-act="start" data-id="${i.id}">▶ Palco</button>` +
    `<button class="btn btn-ghost mini-btn" data-act="up" data-id="${i.id}">↑</button>` +
    `<button class="btn btn-ghost mini-btn" data-act="down" data-id="${i.id}">↓</button>` +
    `<button class="btn btn-ghost mini-btn" data-act="remove" data-id="${i.id}">✕</button></div>`
  ).join('') : '<div class="names-list">Fila vazia.</div>';

  // Resultados
  $('resultsList').innerHTML = S.results.length ? [...S.results].reverse().map((i) =>
    `<div class="list-row"><img src="${i.photo}" alt=""><div class="grow"><b>Mini Nº ${i.itemNo}</b><div class="small">${i.status === 'sold' ? `${esc(i.winnerName)} — ${fmt(i.finalPrice)}` : 'Ninguém deu lance'}</div></div>` +
    `<span class="tag ${i.status}">${i.status === 'sold' ? 'ARREMATADA' : 'SEM LANCE'}</span>` +
    `<button class="btn mini-btn" data-act="requeue" data-id="${i.id}">↩ Refazer</button></div>`
  ).join('') : '<div class="names-list">Nenhuma mini encerrada ainda.</div>';

  // Chat
  const box = $('orgChatMsgs');
  box.innerHTML = S.chat.map((m) => m.kind === 'system'
    ? `<div class="msg system">${esc(m.body)}</div>`
    : `<div class="msg"><span class="who">${esc(m.name)}:</span> ${esc(m.body)}</div>`
  ).join('');
  box.scrollTop = box.scrollHeight;

  // Liga os botões das listas
  document.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = () => {
      const { act, id } = b.dataset;
      if (act === 'up') moveInQueue(id, -1);
      else if (act === 'down') moveInQueue(id, 1);
      else queueAction(id, act);
    };
  });
}

async function fetchState() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    S = await r.json();
    serverOffset = S.serverNow - Date.now();
    render();
  } catch {}
}

checkAuth();
setInterval(() => { if (S) fetchState(); }, 2000);
