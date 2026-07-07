const $ = (id) => document.getElementById(id);
const esc = (t = '') => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let token = localStorage.getItem('wa_token') || '';
let me = null, authMode = 'login', sse = null;
let accounts = [], currentAccount = '', currentChat = '', currentName = '';

/* ---------- HTTP ---------- */
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) },
  });
  if ((res.status === 401 || res.status === 403) && me) logout();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/* ---------- helpers ---------- */
const phoneOf = (jid) => (jid || '').split('@')[0];
const initials = (s = '') => (s.trim()[0] || '?').toUpperCase();
function avatarColor(s = '') { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 45% 45%)`; }
function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  const hm = d.toTimeString().slice(0, 5);
  if (d.toDateString() === now.toDateString()) return hm;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}
const MEDIA_LABEL = { image: '📷 Foto', sticker: '🔖 Figurinha', video: '🎥 Vídeo', gif: '🎞️ GIF', audio: '🎤 Áudio', document: '📄 Documento' };
function mediaLabel(t) { return MEDIA_LABEL[t] || '📎 Mídia'; }
function mediaHtml(m) {
  const url = `/api/accounts/${currentAccount}/media/${encodeURIComponent(m.wa_id)}`;
  switch (m.media_type) {
    case 'image':
    case 'sticker':
      return `<img class="msg-img ${m.media_type}" src="${url}" loading="lazy" onclick="openImg('${url}')" onerror="mediaErr(this,'${m.media_type}')">`;
    case 'video':
    case 'gif':
      return `<video class="msg-vid" controls preload="metadata" src="${url}" onerror="mediaErr(this,'${m.media_type}')"></video>`;
    case 'audio':
      return `<audio class="msg-aud" controls preload="none" src="${url}"></audio>`;
    case 'document':
      return `<a class="msg-doc" href="${url}" target="_blank" rel="noopener">📄 ${esc(m.media_name || 'Documento')}</a>`;
    default:
      return `<span class="body">${esc(m.body || '')}</span>`;
  }
}
window.mediaErr = (el, type) => { const s = document.createElement('span'); s.className = 'body media-fail'; s.textContent = mediaLabel(type) + ' (indisponível)'; el.replaceWith(s); };
window.openImg = (url) => { const o = document.createElement('div'); o.className = 'lightbox'; o.innerHTML = `<img src="${url}">`; o.onclick = () => o.remove(); document.body.appendChild(o); };
function dayLabel(ts) {
  const d = new Date(ts), today = new Date(), y = new Date(); y.setDate(y.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Hoje';
  if (d.toDateString() === y.toDateString()) return 'Ontem';
  if ((today - d) / 86400000 < 7) return d.toLocaleDateString('pt-BR', { weekday: 'long' });
  return d.toLocaleDateString('pt-BR');
}
const stIcon = { open: '🟢', qr: '🟡', closed: '⚪' };

/* ---------- avatares (foto de perfil, lazy + cache) ---------- */
const picCache = new Map();
const drafts = new Map(); // rascunho por chat (preserva o que voce digitou ao trocar)
function applyAvatar(el, url) {
  if (!el || !url) return;
  el.style.backgroundImage = `url("${url}")`;
  el.style.backgroundSize = 'cover';
  el.style.backgroundPosition = 'center';
  el.textContent = '';
}
async function loadAvatar(jid, el) {
  if (!jid || !el) return;
  if (picCache.has(jid)) { applyAvatar(el, picCache.get(jid)); return; }
  try {
    const { url } = await api(`/accounts/${currentAccount}/chats/${encodeURIComponent(jid)}/avatar`);
    picCache.set(jid, url || null);
    applyAvatar(el, url);
  } catch {}
}
const avatarIO = ('IntersectionObserver' in window)
  ? new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (e.isIntersecting) { loadAvatar(e.target.dataset.jid, e.target.querySelector('.avatar')); obs.unobserve(e.target); }
      }
    }, { rootMargin: '100px' })
  : null;

/* ---------- AUTH ---------- */
document.querySelectorAll('.auth-tabs button').forEach((b) => b.addEventListener('click', () => {
  authMode = b.dataset.auth;
  document.querySelectorAll('.auth-tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $('f-name').classList.toggle('hidden', authMode !== 'register');
  $('auth-submit').textContent = authMode === 'register' ? 'Criar conta' : 'Entrar';
  $('auth-msg').textContent = '';
}));
$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { email: $('f-email').value, password: $('f-pass').value };
  if (authMode === 'register') body.name = $('f-name').value;
  try {
    const data = await api('/auth/' + authMode, { method: 'POST', body: JSON.stringify(body) });
    if (data.pending) { $('auth-msg').textContent = 'Conta criada. Aguarde aprovação do admin.'; $('auth-msg').className = 'msg ok'; return; }
    token = data.token; localStorage.setItem('wa_token', token); me = data.user; enterApp();
  } catch (err) { $('auth-msg').textContent = err.message; $('auth-msg').className = 'msg err'; }
});
function logout() {
  token = ''; me = null; localStorage.removeItem('wa_token'); if (sse) sse.close();
  $('app').classList.add('hidden'); $('settings').classList.add('hidden'); $('auth').classList.remove('hidden');
}
$('logout').addEventListener('click', logout);

/* ---------- BOOT ---------- */
async function enterApp() {
  $('auth').classList.add('hidden'); $('app').classList.remove('hidden');
  $('me-avatar').textContent = initials(me.name); $('me-avatar').style.background = avatarColor(me.name);
  document.querySelectorAll('.admin-only').forEach((el) => el.classList.toggle('hidden', me.role !== 'admin'));
  $('tgId').value = me.telegram_chat_id || '';
  connectSSE();
  await loadAccounts();
  setupPush();
}

/* ---------- PUSH NOTIFICATIONS ---------- */
function urlB64ToUint8(b) {
  const pad = '='.repeat((4 - (b.length % 4)) % 4);
  const s = (b + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function subscribePush(reg, key) {
  const sub = (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) }));
  await api('/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
}
async function setupPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    if (Notification.permission !== 'granted') return; // só assina depois que o usuário permite (botão 🔔)
    const { key } = await api('/push/key'); if (!key) return;
    await subscribePush(reg, key);
  } catch (e) { console.warn('push setup', e); }
}
$('bell').addEventListener('click', async () => {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('Este navegador não suporta notificações push.'); return;
  }
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (isIOS && !standalone) {
    alert('No iPhone: toque em Compartilhar → "Adicionar à Tela de Início", abra pelo ícone e então ative as notificações. (As notificações aparecem também no Apple Watch.)');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { alert('Permissão de notificação negada.'); return; }
    const { key } = await api('/push/key');
    if (!key) { alert('Push não configurado no servidor.'); return; }
    await subscribePush(reg, key);
    alert('Notificações ativadas! 🔔');
  } catch (e) { alert('Erro ao ativar push: ' + e.message); }
});

function connectSSE() {
  if (sse) sse.close();
  sse = new EventSource('/api/stream?token=' + encodeURIComponent(token));
  sse.addEventListener('message', (e) => { const d = JSON.parse(e.data); if (d.accountId === currentAccount) { loadChats(); if (d.jid === currentChat) loadMessages(currentChat); } });
  sse.addEventListener('suggestion', (e) => { const d = JSON.parse(e.data); if (d.accountId === currentAccount) { loadChats(); if (d.jid === currentChat && !$('input').value.trim()) setInput(d.suggestion); } });
  sse.addEventListener('updated', () => loadChats());
  sse.addEventListener('wa-status', () => loadAccounts());
}

/* ---------- ACCOUNTS ---------- */
async function loadAccounts() {
  accounts = await api('/accounts');
  const sel = $('acct');
  sel.innerHTML = accounts.map((a) => `<option value="${a.id}">${stIcon[a.status] || '⚪'} ${esc(a.label)}</option>`).join('');
  if (!accounts.length) {
    $('emptyHint').textContent = 'Nenhum número. Abra ⚙ Configurações › Conectar número.';
    $('chatList').innerHTML = '<div class="chat-empty">Conecte um número em ⚙</div>';
    renderAccountList(); return;
  }
  if (!currentAccount || !accounts.find((a) => a.id === currentAccount)) currentAccount = accounts[0].id;
  sel.value = currentAccount;
  renderAccountList();
  loadChats();
}
$('acct').addEventListener('change', (e) => { currentAccount = e.target.value; currentChat = ''; showEmpty(); loadChats(); });

/* ---------- CHAT LIST ---------- */
async function loadChats() {
  if (!currentAccount) return;
  let chats = [];
  try { chats = await api(`/accounts/${currentAccount}/chats`); } catch { return; }
  if (!chats.length) { $('chatList').innerHTML = '<div class="chat-empty">Sem conversas ainda.<br>Mensagens recebidas aparecem aqui.</div>'; return; }
  $('chatList').innerHTML = chats.map((c) => {
    const name = c.name || phoneOf(c.jid);
    const prefix = c.last_from_me ? '✓ ' : '';
    const badge = !c.last_from_me ? '<span class="ci-dot" title="aguardando resposta"></span>' : '';
    return `<div class="chat-item ${c.jid === currentChat ? 'active' : ''}" data-jid="${esc(c.jid)}" data-name="${esc(name)}" data-search="${esc((name + ' ' + (c.last_body || '')).toLowerCase())}">
      <div class="avatar" style="background:${avatarColor(name)}">${esc(initials(name))}</div>
      <div class="ci-body">
        <div class="ci-top"><span class="ci-name">${esc(name)}</span><span class="ci-time">${fmtTime(c.last_ts)}</span></div>
        <div class="ci-top"><span class="ci-last">${esc(prefix + (c.last_body || ''))}</span>${badge}</div>
      </div></div>`;
  }).join('');
  document.querySelectorAll('.chat-item').forEach((el) => {
    el.addEventListener('click', () => openChat(el.dataset.jid, el.dataset.name));
    if (avatarIO) avatarIO.observe(el); else loadAvatar(el.dataset.jid, el.querySelector('.avatar'));
  });
  applySearch();
}
function applySearch() {
  const q = ($('search').value || '').toLowerCase().trim();
  document.querySelectorAll('.chat-item').forEach((el) => { el.style.display = (!q || el.dataset.search.includes(q)) ? '' : 'none'; });
}
$('search').addEventListener('input', applySearch);

/* ---------- CHAT VIEW ---------- */
function showEmpty() { $('emptyState').classList.remove('hidden'); $('chatView').classList.add('hidden'); document.body.classList.remove('chat-open'); }
$('back').addEventListener('click', () => { currentChat = ''; document.body.classList.remove('chat-open'); loadChats(); });

async function openChat(jid, name) {
  if (currentChat && currentChat !== jid) drafts.set(currentChat, $('input').value); // guarda rascunho do chat atual
  currentChat = jid; currentName = name;
  $('emptyState').classList.add('hidden'); $('chatView').classList.remove('hidden'); document.body.classList.add('chat-open');
  $('peerName').textContent = name; $('peerSub').textContent = phoneOf(jid);
  $('peerAvatar').textContent = initials(name); $('peerAvatar').style.background = avatarColor(name); $('peerAvatar').style.backgroundImage = '';
  loadAvatar(jid, $('peerAvatar'));
  document.querySelectorAll('.chat-item').forEach((el) => el.classList.toggle('active', el.dataset.jid === jid));
  await loadMessages(jid);
  const draft = drafts.get(jid);
  if (draft !== undefined) { setInput(draft); }   // rascunho salvo tem prioridade
  else { setInput(''); requestSuggestion(jid); }   // gera sob demanda (lazy)
}

// Pede a sugestao do chat (gera no servidor ou reusa cache). So preenche se ainda relevante.
async function requestSuggestion(jid) {
  if (currentChat !== jid) return;
  const inp = $('input');
  inp.placeholder = '✨ gerando sugestão…';
  try {
    const { suggestion } = await api(`/accounts/${currentAccount}/chats/${encodeURIComponent(jid)}/suggest`, { method: 'POST' });
    if (currentChat === jid && suggestion && !inp.value.trim() && drafts.get(jid) === undefined) setInput(suggestion);
  } catch {}
  finally { if (currentChat === jid) inp.placeholder = 'Mensagem'; }
}

async function loadMessages(jid) {
  let data;
  try { data = await api(`/accounts/${currentAccount}/chats/${encodeURIComponent(jid)}/messages`); } catch { return; }
  let html = '', lastDay = '';
  for (const m of data.messages) {
    const dk = new Date(m.ts).toDateString();
    if (dk !== lastDay) { html += `<div class="day-sep">${dayLabel(m.ts)}</div>`; lastDay = dk; }
    const time = new Date(m.ts).toTimeString().slice(0, 5);
    const tick = m.from_me ? '<span class="tick">✓✓</span>' : '';
    let inner, hasMedia = '';
    if (m.media_type) {
      inner = mediaHtml(m);
      if (m.media_caption) inner += `<span class="body cap">${esc(m.media_caption)}</span>`;
      hasMedia = ' has-media';
    } else {
      inner = `<span class="body">${esc(m.body)}</span>`;
    }
    html += `<div class="bubble ${m.from_me ? 'out' : 'in'}${hasMedia}">${inner}<span class="meta">${time}${tick}</span></div>`;
  }
  const box = $('messages'); box.innerHTML = html; box.scrollTop = box.scrollHeight;
  return data;
}

/* ---------- COMPOSER ---------- */
const input = $('input');
function setInput(v) { input.value = v || ''; autosize(); }
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; }
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
$('send').addEventListener('click', doSend);

// página de contato (Dados)
function openContact() {
  if (!currentChat) return;
  $('cName').textContent = currentName;
  $('cPhone').textContent = '+' + phoneOf(currentChat);
  const av = $('cAvatar');
  av.textContent = initials(currentName); av.style.background = avatarColor(currentName); av.style.backgroundImage = '';
  if (picCache.get(currentChat)) applyAvatar(av, picCache.get(currentChat)); else loadAvatar(currentChat, av);
  $('contact').classList.remove('hidden');
}
$('chatHead').addEventListener('click', (e) => { if (e.target.closest('#back')) return; openContact(); });
$('contactClose').addEventListener('click', () => $('contact').classList.add('hidden'));
async function renameCurrentChat() {
  if (!currentChat) return;
  const nm = prompt('Nome do contato:', currentName);
  if (!nm || !nm.trim()) return;
  try {
    await api(`/accounts/${currentAccount}/chats/${encodeURIComponent(currentChat)}/name`, { method: 'POST', body: JSON.stringify({ name: nm.trim() }) });
    currentName = nm.trim(); $('peerName').textContent = currentName; $('cName').textContent = currentName; loadChats();
  } catch (e) { alert('Erro: ' + e.message); }
}
$('cRename').addEventListener('click', renameCurrentChat);

async function doSend() {
  const text = input.value.trim();
  if (!text || !currentChat) return;
  $('send').disabled = true;
  try {
    await api(`/accounts/${currentAccount}/chats/${encodeURIComponent(currentChat)}/send`, { method: 'POST', body: JSON.stringify({ text }) });
    drafts.delete(currentChat); setInput(''); await loadMessages(currentChat); loadChats();
  } catch (err) { alert('Erro: ' + err.message); }
  finally { $('send').disabled = false; }
}

/* ---------- TONE REWRITE ---------- */
$('toneBtn').addEventListener('click', (e) => { e.stopPropagation(); $('toneMenu').classList.toggle('hidden'); });
document.addEventListener('click', () => $('toneMenu').classList.add('hidden'));
$('toneMenu').addEventListener('click', (e) => e.stopPropagation());
document.querySelectorAll('#toneMenu button').forEach((b) => b.addEventListener('click', async () => {
  $('toneMenu').classList.add('hidden');
  let tone = b.dataset.tone;
  if (tone === '__custom__') { tone = prompt('Descreva o tom desejado:', 'mais descontraído'); if (!tone) return; }
  const text = input.value.trim();
  if (!text) { alert('Digite ou aprove uma mensagem primeiro.'); return; }
  const old = input.value; setInput('Reescrevendo…'); input.disabled = true;
  try { const r = await api('/rewrite', { method: 'POST', body: JSON.stringify({ text, tone }) }); setInput(r.text); }
  catch (err) { setInput(old); alert('Erro: ' + err.message); }
  finally { input.disabled = false; input.focus(); }
}));

/* ---------- SETTINGS ---------- */
$('gear').addEventListener('click', () => { $('settings').classList.remove('hidden'); renderAccountList(); });
$('settingsClose').addEventListener('click', () => $('settings').classList.add('hidden'));
document.querySelectorAll('.settings-tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.settings-tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.st-view').forEach((v) => v.classList.add('hidden'));
  $('st-' + b.dataset.st).classList.remove('hidden');
  if (b.dataset.st === 'users') loadUsers();
}));

function renderAccountList() {
  $('acctList').innerHTML = accounts.map((a) => `<div class="card">
    <div><b class="acct-label" ondblclick="renameAccount('${a.id}')" title="2 cliques para renomear">${esc(a.label)}</b> <span class="badge ${a.status==='open'?'on':'off'}">${stIcon[a.status]||''} ${a.status}</span></div>
    <div class="actions">
      ${a.status!=='open'?`<button class="btn-primary sm" onclick="showQR('${a.id}')">QR</button>`:''}
      <button class="link" onclick="relinkAccount('${a.id}')" title="Re-parear e recarregar histórico">↻ Histórico</button>
      <button class="btn-danger" onclick="delAccount('${a.id}')">Remover</button>
    </div>
  </div>`).join('') || '<p class="muted">Nenhum número conectado.</p>';
}
$('addAccount').addEventListener('click', async () => {
  const label = prompt('Apelido do número (ex.: Pessoal):', 'WhatsApp'); if (label === null) return;
  try { const a = await api('/accounts', { method: 'POST', body: JSON.stringify({ label }) }); await loadAccounts(); showQR(a.id); }
  catch (e) { alert('Erro: ' + e.message); }
});
window.delAccount = async (id) => { if (!confirm('Remover este número?')) return; try { await api(`/accounts/${id}`, { method: 'DELETE' }); await loadAccounts(); } catch (e) { alert('Erro: ' + e.message); } };
window.renameAccount = async (id) => {
  const cur = accounts.find((a) => a.id === id);
  const nm = prompt('Apelido do número:', cur?.label || '');
  if (!nm || !nm.trim()) return;
  try { await api(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ label: nm.trim() }) }); await loadAccounts(); }
  catch (e) { alert('Erro: ' + e.message); }
};
window.relinkAccount = async (id) => {
  if (!confirm('Vai desconectar este número e pedir um novo QR. Ao reparear, o WhatsApp reenvia as conversas e o histórico recente. Continuar?')) return;
  try { await api(`/accounts/${id}/relink`, { method: 'POST' }); showQR(id); } catch (e) { alert('Erro: ' + e.message); }
};

/* QR */
let qrTimer = null;
window.showQR = async (id) => {
  $('qrModal').classList.remove('hidden'); $('qrImg').src = ''; $('qrStatus').textContent = 'gerando QR…';
  await api(`/accounts/${id}/connect`, { method: 'POST' }).catch(() => {});
  const poll = async () => {
    try { const { status, qr } = await api(`/accounts/${id}/qr`);
      if (status === 'open') { closeQR(); loadAccounts(); return; }
      if (qr) { $('qrImg').src = qr; $('qrStatus').textContent = 'aguardando leitura…'; } else $('qrStatus').textContent = 'gerando QR…';
    } catch (e) { $('qrStatus').textContent = e.message; }
  };
  poll(); qrTimer = setInterval(poll, 2000);
};
function closeQR() { clearInterval(qrTimer); qrTimer = null; $('qrModal').classList.add('hidden'); }
$('qrClose').addEventListener('click', closeQR);

/* Telegram */
$('tgSave').addEventListener('click', async () => {
  try { const u = await api('/me/telegram', { method: 'POST', body: JSON.stringify({ chatId: $('tgId').value }) }); me.telegram_chat_id = u.telegram_chat_id; $('tgMsg').textContent = 'Salvo.'; $('tgMsg').className = 'msg ok'; }
  catch (e) { $('tgMsg').textContent = e.message; $('tgMsg').className = 'msg err'; }
});

/* Admin users */
async function loadUsers() {
  const data = await api('/users');
  $('usersList').innerHTML = data.map((u) => `<div class="card">
    <div><b>${esc(u.name)}</b> <span class="muted">${esc(u.email)}</span> <span class="badge ${u.approved?'on':'off'}">${u.approved?u.role:'pendente'}</span></div>
    <div class="actions">
      ${!u.approved?`<button class="btn-primary sm" onclick="approveUser('${esc(u.email)}')">Aprovar</button>`:''}
      <button class="link" onclick="toggleRole('${esc(u.email)}','${u.role}')">${u.role==='admin'?'↓ user':'↑ admin'}</button>
      ${u.email!==me.email?`<button class="btn-danger" onclick="delUser('${esc(u.email)}')">Excluir</button>`:''}
    </div></div>`).join('');
}
window.approveUser = async (em) => { await api(`/users/${encodeURIComponent(em)}`, { method: 'PATCH', body: JSON.stringify({ approved: true }) }); loadUsers(); };
window.toggleRole = async (em, r) => { await api(`/users/${encodeURIComponent(em)}`, { method: 'PATCH', body: JSON.stringify({ role: r === 'admin' ? 'user' : 'admin' }) }); loadUsers(); };
window.delUser = async (em) => { if (confirm('Excluir ' + em + '?')) { await api(`/users/${encodeURIComponent(em)}`, { method: 'DELETE' }); loadUsers(); } };

/* ---------- start ---------- */
(async function boot() {
  if (token) { try { me = await api('/me'); enterApp(); return; } catch {} }
  $('auth').classList.remove('hidden');
})();
