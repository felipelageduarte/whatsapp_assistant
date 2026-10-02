// REST + SSE. Auth via JWT (Bearer). Tudo escopado por owner; admin gerencia users.
import express from 'express';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { store } from './store.js';
import { bus } from './bus.js';
import * as authmod from './auth.js';
import { authMiddleware, requireAdmin, pub, verify } from './auth.js';
import { approveSuggestion, rejectSuggestion } from './actions.js';
import { startSession, stopSession, getQR, getSession, sendFromAccount, getProfilePicture, getMediaStream, suggestForChat } from './whatsapp.js';
import { rewriteMessage } from './llm.js';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

// account + status ao vivo da sessao
function accountView(a) {
  const live = getSession(a.id);
  return { id: a.id, label: a.label, status: live?.status || a.status, createdAt: a.created_at };
}

function ownAccount(req, res) {
  const a = store.getAccount(req.params.id);
  if (!a) { res.status(404).json({ error: 'numero nao encontrado' }); return null; }
  if (a.owner !== req.user.email) { res.status(403).json({ error: 'sem permissao' }); return null; }
  return a;
}

// Owner fixo das contas gerenciadas pelo BotImóvel via endpoints /bridge/*
// (não há usuário local — a UI é a página whatsapp.html do BotImóvel, que
// autentica lá com bi_token e chega aqui via proxy da Lambda com o secret).
// accounts.owner tem FK pra users(email), então o user fantasma precisa
// existir — criado lazy, com hash impossível de bater (não é senha scrypt
// válida) e approved=0: ninguém consegue logar como ele na web app local.
const BRIDGE_OWNER = 'botimovel@bridge';

function ensureBridgeOwner() {
  if (!store.getUser(BRIDGE_OWNER)) {
    store.createUser({
      email: BRIDGE_OWNER, name: 'BotImóvel (bridge)', role: 'user',
      passwordHash: 'bridge-service-account-no-login', approved: false,
    });
  }
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Auth dos endpoints /bridge/*: mesmo secret compartilhado que este processo
// usa pra falar com o BotImóvel (simétrico de propósito — um canal, um secret).
function bridgeAuth(req, res, next) {
  const secret = config.botimovelBridgeSecret;
  if (!secret || !timingSafeEqual(req.get('x-whatsapp-bridge-secret'), secret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

export function startApi() {
  const app = express();
  app.use(express.json());
  app.use(express.static(webDir));

  /* ---------- endpoints headless pro BotImóvel (auth por secret) ---------- */
  // Gestão de contas/QR consumida pela página whatsapp.html do BotImóvel via
  // proxy na Lambda (routes/whatsapp.mjs) — nunca exposta direto ao browser.
  app.get('/bridge/accounts', bridgeAuth, (req, res) => {
    res.json(store.listAccounts(BRIDGE_OWNER).map(accountView));
  });

  app.post('/bridge/accounts', bridgeAuth, (req, res) => {
    ensureBridgeOwner();
    const id = crypto.randomUUID();
    const a = store.createAccount({ id, owner: BRIDGE_OWNER, label: req.body?.label || 'WhatsApp da empresa' });
    // Fire-and-forget: startSession leva >10s (S3 + versao Baileys + socket)
    // e o proxy da Lambda tem timeout — o QR chega pelo polling de
    // /bridge/accounts/:id/qr de qualquer jeito.
    startSession(id).catch((err) => console.error(`[bridge] startSession ${id.slice(0, 8)}:`, err.message));
    res.json(accountView(a));
  });

  app.get('/bridge/accounts/:id/qr', bridgeAuth, (req, res) => {
    const a = store.getAccount(req.params.id);
    if (!a) return res.status(404).json({ error: 'numero nao encontrado' });
    res.json({ status: getSession(a.id)?.status || a.status, qr: getQR(a.id) });
  });

  app.post('/bridge/accounts/:id/connect', bridgeAuth, (req, res) => {
    const a = store.getAccount(req.params.id);
    if (!a) return res.status(404).json({ error: 'numero nao encontrado' });
    startSession(a.id).catch((err) => console.error(`[bridge] startSession ${a.id.slice(0, 8)}:`, err.message));
    res.json(accountView(store.getAccount(a.id)));
  });

  app.post('/bridge/accounts/:id/relink', bridgeAuth, async (req, res) => {
    const a = store.getAccount(req.params.id);
    if (!a) return res.status(404).json({ error: 'numero nao encontrado' });
    await stopSession(a.id, { logout: true });
    startSession(a.id).catch(() => {});
    res.json({ ok: true });
  });

  app.delete('/bridge/accounts/:id', bridgeAuth, async (req, res) => {
    const a = store.getAccount(req.params.id);
    if (!a) return res.status(404).json({ error: 'numero nao encontrado' });
    await stopSession(a.id, { logout: true });
    store.deleteAccount(a.id);
    res.json({ ok: true });
  });

  /* ---------- auth publico ---------- */
  app.post('/api/auth/register', (req, res) => {
    const { code, body } = authmod.register(req.body || {});
    res.status(code).json(body);
  });
  app.post('/api/auth/login', (req, res) => {
    const { code, body } = authmod.login(req.body || {});
    res.status(code).json(body);
  });

  /* ---------- SSE (auth por ?token=, pois EventSource nao manda header) ---------- */
  app.get('/api/stream', (req, res) => {
    const payload = verify(req.query.token);
    if (!payload) return res.status(401).end();
    const email = payload.email;

    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(': connected\n\n');

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const mine = (d) => d?.owner === email;
    const onSuggestion = (s) => mine(s) && send('suggestion', s);
    const onUpdated = (s) => mine(s) && send('updated', s);
    const onStatus = (s) => mine(s) && send('wa-status', s);
    const onMessage = (s) => mine(s) && send('message', s);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);

    bus.on('suggestion', onSuggestion);
    bus.on('updated', onUpdated);
    bus.on('wa-status', onStatus);
    bus.on('message', onMessage);
    req.on('close', () => {
      clearInterval(ping);
      bus.off('suggestion', onSuggestion);
      bus.off('updated', onUpdated);
      bus.off('wa-status', onStatus);
      bus.off('message', onMessage);
    });
  });

  /* ---------- daqui pra baixo exige auth ---------- */
  app.use('/api', authMiddleware);

  app.get('/api/me', (req, res) => res.json(pub(req.user)));

  /* ---------- push notifications ---------- */
  app.get('/api/push/key', (req, res) => res.json({ key: config.vapidPublic || null }));
  app.post('/api/push/subscribe', (req, res) => {
    const s = req.body?.subscription;
    if (!s?.endpoint) return res.status(400).json({ error: 'subscription invalida' });
    store.addSub(req.user.email, s);
    res.json({ ok: true });
  });
  app.post('/api/push/unsubscribe', (req, res) => {
    if (req.body?.endpoint) store.delSub(req.body.endpoint);
    res.json({ ok: true });
  });

  app.post('/api/me/telegram', (req, res) => {
    const chatId = String(req.body?.chatId || '').trim() || null;
    res.json(pub(store.setTelegram(req.user.email, chatId)));
  });

  /* ---------- accounts (numeros WhatsApp) ---------- */
  app.get('/api/accounts', (req, res) => {
    res.json(store.listAccounts(req.user.email).map(accountView));
  });

  app.post('/api/accounts', async (req, res) => {
    const id = crypto.randomUUID();
    const a = store.createAccount({ id, owner: req.user.email, label: req.body?.label || 'WhatsApp' });
    try {
      await startSession(id); // dispara geracao de QR
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(accountView(a));
  });

  app.patch('/api/accounts/:id', (req, res) => {
    const a = ownAccount(req, res); if (!a) return;
    const label = String(req.body?.label || '').trim();
    if (!label) return res.status(400).json({ error: 'apelido vazio' });
    res.json(accountView(store.setAccountLabel(a.id, label)));
  });

  app.get('/api/accounts/:id/qr', (req, res) => {
    const a = ownAccount(req, res); if (!a) return;
    res.json({ status: getSession(a.id)?.status || a.status, qr: getQR(a.id) });
  });

  app.post('/api/accounts/:id/connect', async (req, res) => {
    const a = ownAccount(req, res); if (!a) return;
    try { await startSession(a.id); } catch (err) { return res.status(500).json({ error: err.message }); }
    res.json(accountView(store.getAccount(a.id)));
  });

  // Re-parear: desconecta + apaga creds -> novo QR -> dispara history sync do telefone.
  app.post('/api/accounts/:id/relink', async (req, res) => {
    const a = ownAccount(req, res); if (!a) return;
    await stopSession(a.id, { logout: true });
    startSession(a.id).catch(() => {});
    res.json({ ok: true });
  });

  app.delete('/api/accounts/:id', async (req, res) => {
    const a = ownAccount(req, res); if (!a) return;
    await stopSession(a.id, { logout: true });
    store.deleteAccount(a.id);
    res.json({ ok: true });
  });

  /* ---------- chats (estilo WhatsApp) ---------- */
  app.get('/api/accounts/:id/chats', (req, res) => {
    const a = ownAccount(req, res); if (!a) return;
    res.json(store.listChats(a.id));
  });

  app.get('/api/accounts/:id/chats/:jid/messages', (req, res) => {
    const a = ownAccount(req, res); if (!a) return;
    const jid = decodeURIComponent(req.params.jid);
    res.json({
      messages: store.chatMessages(a.id, jid, Number(req.query.limit) || 80),
      pending: store.pendingForChat(a.id, jid) || null,
    });
  });

  // Envia mensagem (manual ou a partir da sugestao editada). Marca sugestao pendente como enviada.
  app.post('/api/accounts/:id/chats/:jid/send', async (req, res) => {
    const a = ownAccount(req, res); if (!a) return;
    const jid = decodeURIComponent(req.params.jid);
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'texto vazio' });
    try {
      await sendFromAccount(a.id, jid, text);
      const pend = store.pendingForChat(a.id, jid);
      if (pend) {
        const updated = store.setStatus(pend.id, 'sent', text);
        bus.emit('updated', updated);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Midia (imagem/figurinha/video/audio/doc): baixa sob demanda, cacheia no S3, faz stream.
  app.get('/api/accounts/:id/media/:waId', async (req, res) => {
    const a = ownAccount(req, res); if (!a) return;
    try {
      const m = await getMediaStream(a.id, decodeURIComponent(req.params.waId));
      if (!m) return res.status(404).end();
      res.setHeader('Content-Type', m.mime || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=604800');
      if (m.name) res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(m.name)}"`);
      m.body.pipe(res);
    } catch (err) {
      res.status(500).end();
    }
  });

  // Foto de perfil do contato (cacheada; URL temporaria do WhatsApp servida ao <img>).
  app.get('/api/accounts/:id/chats/:jid/avatar', async (req, res) => {
    const a = ownAccount(req, res); if (!a) return;
    const jid = decodeURIComponent(req.params.jid);
    const cached = store.getPic(a.id, jid);
    const ttl = (cached?.url ? 6 * 3600e3 : 24 * 3600e3); // com foto: 6h; sem: 24h
    if (cached && Date.now() - cached.ts < ttl) return res.json({ url: cached.url || null });
    const url = await getProfilePicture(a.id, jid).catch(() => null);
    store.setPic(a.id, jid, url || '');
    res.json({ url: url || null });
  });

  // Renomeia um contato/chat manualmente (a agenda do WhatsApp nem sempre e enviada).
  app.post('/api/accounts/:id/chats/:jid/name', (req, res) => {
    const a = ownAccount(req, res); if (!a) return;
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'nome vazio' });
    store.upsertContact(a.id, decodeURIComponent(req.params.jid), name);
    res.json({ ok: true });
  });

  // Gera (ou reusa do cache) a sugestao do chat — chamado quando o chat e aberto.
  app.post('/api/accounts/:id/chats/:jid/suggest', async (req, res) => {
    const a = ownAccount(req, res); if (!a) return;
    try {
      const row = await suggestForChat(a.id, decodeURIComponent(req.params.jid));
      res.json({ suggestion: row?.suggestion || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Reescreve um texto ajustando o tom (nao envia).
  app.post('/api/rewrite', async (req, res) => {
    try {
      const text = await rewriteMessage({ text: req.body?.text, tone: req.body?.tone });
      res.json({ text });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /* ---------- suggestions ---------- */
  app.get('/api/suggestions', (req, res) => {
    const { status, limit } = req.query;
    res.json(store.listSuggestions({ owner: req.user.email, status, limit: Number(limit) || 50 }));
  });

  app.post('/api/suggestions/:id/approve', async (req, res) => {
    try {
      const updated = await approveSuggestion(Number(req.params.id), { owner: req.user.email, editedText: req.body?.text });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/suggestions/:id/reject', (req, res) => {
    try {
      res.json(rejectSuggestion(Number(req.params.id), { owner: req.user.email }));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /* ---------- admin: gestao de usuarios ---------- */
  app.get('/api/users', requireAdmin, (req, res) => {
    res.json(store.listUsers().map(pub));
  });
  app.patch('/api/users/:email', requireAdmin, (req, res) => {
    const email = req.params.email.toLowerCase();
    if (!store.getUser(email)) return res.status(404).json({ error: 'usuario nao encontrado' });
    if (typeof req.body?.approved === 'boolean') store.setApproved(email, req.body.approved);
    if (req.body?.role === 'admin' || req.body?.role === 'user') store.setRole(email, req.body.role);
    res.json(pub(store.getUser(email)));
  });
  app.delete('/api/users/:email', requireAdmin, (req, res) => {
    const email = req.params.email.toLowerCase();
    if (email === req.user.email) return res.status(400).json({ error: 'nao pode excluir a si mesmo' });
    // encerra sessoes do usuario antes de remover
    for (const a of store.listAccounts(email)) stopSession(a.id, { logout: false });
    store.deleteUser(email);
    res.json({ ok: true });
  });

  app.listen(config.port, () => {
    console.log(`[api] web app em http://localhost:${config.port}`);
  });
}
