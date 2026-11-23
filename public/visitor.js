/* Leilão AW Diecast — visão de quem assiste */
'use strict';

const $ = (id) => document.getElementById(id);
const fmt = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
const WHATS_NUMBER = '14073018488';

let myName = localStorage.getItem('aw-nome') || '';
let visitorId = localStorage.getItem('aw-visitor-id');
if (!visitorId) {
  visitorId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem('aw-visitor-id', visitorId);
}

let S = null; // último estado recebido
let serverOffset = 0; // serverNow - Date.now()
let chatDraftPending = null; // texto do chat aguardando o nome

/* ------------------------------------------------------------------- nome */

function refreshNameUI() {
  if (myName) {
    $('nameRow').classList.add('hidden');
    $('nameSaved').classList.remove('hidden');
    $('savedName').textContent = myName;
  } else {
    $('nameRow').classList.remove('hidden');
    $('nameSaved').classList.add('hidden');
  }
}

function promptForName(hintText) {
  $('nameHint').textContent = hintText || 'Falta só o seu nome — digite aqui em cima e toque em Entrar';
  window.scrollTo(0, 0);
  $('nameRow').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => $('nameInput').focus(), 250);
}

function saveName() {
  const v = $('nameInput').value.trim();
  if (!v) { promptForName('Digite seu nome pra continuar'); return; }
  myName = v.slice(0, 40);
  localStorage.setItem('aw-nome', myName);
  $('nameHint').textContent = '';
  refreshNameUI();
  sendPresence();
  if (chatDraftPending) {
    const text = chatDraftPending;
    chatDraftPending = null;
    postChat(text);
  }
  render();
}

$('nameSaveBtn').addEventListener('click', saveName);
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveName(); } });
$('nameEditBtn').addEventListener('click', () => {
  $('nameInput').value = myName;
  $('nameRow').classList.remove('hidden');
  $('nameSaved').classList.add('hidden');
  $('nameInput').focus();
});

/* --------------------------------------------------------------- presença */

async function sendPresence() {
  if (!myName) return;
  try {
    await fetch('/api/presence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId, name: myName }),
    });
  } catch {}
}
setInterval(sendPresence, 8000);

/* ------------------------------------------------------------------ chat */

async function postChat(text) {
  try {
    const r = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId, name: myName, body: text }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Não foi possível enviar');
    $('chatError').textContent = '';
    fetchState();
  } catch (err) {
    $('chatError').textContent = err.message;
  }
}

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  if (!myName) {
    // Sem nome: guarda o rascunho, pede o nome e entrega depois do Entrar.
    chatDraftPending = text;
    $('chatInput').value = '';
    $('chatError').textContent = '';
    promptForName('Falta só o seu nome pra conversar — digite aqui e toque em Entrar');
    return;
  }
  $('chatInput').value = '';
  postChat(text);
});

/* ----------------------------------------------------------------- lance */

$('bidBtn').addEventListener('click', async () => {
  if (!S || !S.liveItem) return;
  if (!myName) { promptForName('Falta só o seu nome pra dar lance — digite aqui e toque em Entrar'); return; }
  try {
    const r = await fetch('/api/bid', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId, name: myName }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Lance não aceito');
    fetchState();
  } catch (err) {
    $('leaderLine').textContent = '⚠️ ' + err.message;
  }
});

/* --------------------------------------------------------------- whatsapp */

$('whatsBtn').addEventListener('click', () => {
  const wins = myWins();
  if (!wins.length) return;
  const lines = wins.map((w) => `• Mini Nº ${w.itemNo} — ${fmt(w.finalPrice)}`);
  const total = wins.reduce((a, w) => a + (w.finalPrice || 0), 0);
  const text = `Olá, Andrews! Sou ${myName} e ganhei no leilão AW Diecast:\n${lines.join('\n')}\nTotal: ${fmt(total)}`;
  const enc = encodeURIComponent(text);
  window.location.href = `whatsapp://send?phone=${WHATS_NUMBER}&text=${enc}`;
  setTimeout(() => {
    if (!document.hidden) window.open(`https://wa.me/${WHATS_NUMBER}?text=${enc}`, '_blank');
  }, 1500);
});

/* ------------------------------------------------------------- renderização */

function myWins() {
  if (!S || !myName) return [];
  return S.results.filter((i) => i.status === 'sold' && i.winnerName === myName);
}

function nowServer() { return Date.now() + serverOffset; }

function tickCountdown() {
  const cd = $('countdown');
  if (S && S.liveItem && S.liveItem.endsAt) {
    const secs = Math.max(0, Math.ceil((S.liveItem.endsAt - nowServer()) / 1000));
    cd.textContent = secs + 's';
    cd.classList.toggle('low', secs <= 5);
  }
}
setInterval(tickCountdown, 200);

function render() {
  if (!S) return;
  $('onlineCount').textContent = S.onlineCount;

  const live = S.liveItem;
  const last = S.lastResult;
  const photo = $('stagePhoto');
  const empty = $('stageEmpty');
  const cd = $('countdown');
  const btn = $('bidBtn');

  if (live) {
    $('resultInfo').classList.add('hidden');
    $('stageInfoRow').classList.remove('hidden');
    $('leaderLine').classList.remove('hidden');
    photo.src = live.photo;
    photo.classList.remove('hidden');
    empty.classList.add('hidden');
    cd.classList.remove('hidden');
    $('stageMiniNo').textContent = `Mini Nº ${live.itemNo}`;
    const price = live.currentBid == null ? live.startPrice : live.currentBid;
    $('stagePrice').textContent = fmt(price);
    if (live.leaderName) {
      $('leaderLine').textContent = live.leaderName === myName
        ? `🎉 Você está ganhando com ${fmt(live.currentBid)}!`
        : `🏆 ${live.leaderName} está ganhando com ${fmt(live.currentBid)}`;
    } else {
      $('leaderLine').textContent = `Valendo! Primeiro lance: ${fmt(live.startPrice)}`;
    }
    const next = live.currentBid == null ? live.startPrice : live.currentBid + live.increment;
    btn.className = 'bid-btn live';
    btn.textContent = `DAR LANCE · ${fmt(next)}`;
    tickCountdown();
  } else {
    cd.classList.add('hidden');
    btn.className = 'bid-btn idle';
    btn.textContent = 'AGUARDANDO INÍCIO';
    if (last) {
      // Cartão de resultado entre uma mini e outra: foto inteira + selo.
      $('resultInfo').classList.remove('hidden');
      $('stageInfoRow').classList.add('hidden');
      $('leaderLine').classList.add('hidden');
      photo.src = last.photo;
      photo.classList.remove('hidden');
      empty.classList.add('hidden');
      const banner = $('resultBanner');
      if (last.status === 'sold') {
        banner.className = 'result-banner sold';
        banner.textContent = `🏆 Mini Nº ${last.itemNo} ARREMATADA`;
        $('resultSub').textContent = last.winnerName === myName
          ? `Você ganhou por ${fmt(last.finalPrice)}! Ela já está na sua lista aqui embaixo.`
          : `${last.winnerName} ganhou por ${fmt(last.finalPrice)}`;
      } else {
        banner.className = 'result-banner nobid';
        banner.textContent = `Mini Nº ${last.itemNo} — SEM LANCE`;
        $('resultSub').textContent = 'Ninguém deu lance nessa.';
      }
    } else {
      $('resultInfo').classList.add('hidden');
      $('stageInfoRow').classList.remove('hidden');
      $('leaderLine').classList.remove('hidden');
      photo.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.textContent = S.auction.status === 'finished' ? '🔒 Leilão encerrado. Obrigado por participar!' : '⏳ Aguardando a próxima mini no palco…';
      $('stageMiniNo').textContent = '';
      $('stagePrice').textContent = '';
      $('leaderLine').textContent = '';
    }
  }

  // Chat
  const box = $('chatMsgs');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = S.chat.map((m) => m.kind === 'system'
    ? `<div class="msg system">${escapeHtml(m.body)}</div>`
    : `<div class="msg"><span class="who">${escapeHtml(m.name)}:</span> ${escapeHtml(m.body)}</div>`
  ).join('');
  if (nearBottom) box.scrollTop = box.scrollHeight;

  // Vitórias pessoais
  const wins = myWins();
  const card = $('winsCard');
  if (wins.length) {
    card.classList.remove('hidden');
    $('winsCount').textContent = wins.length;
    $('winsList').innerHTML = wins.map((w) =>
      `<div class="win-row"><img src="${w.photo}" alt=""><span class="wname">Mini Nº ${w.itemNo}</span><span class="wprice">${fmt(w.finalPrice)}</span></div>`
    ).join('');
    const total = wins.reduce((a, w) => a + (w.finalPrice || 0), 0);
    $('winsTotal').textContent = `Total das suas minis: ${fmt(total)}`;
    $('whatsBtn').classList.toggle('hidden', S.auction.status !== 'finished');
  } else {
    card.classList.add('hidden');
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function fetchState() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    S = await r.json();
    serverOffset = S.serverNow - Date.now();
    render();
  } catch {}
}

refreshNameUI();
if (myName) sendPresence();
fetchState();
setInterval(fetchState, 2000);
