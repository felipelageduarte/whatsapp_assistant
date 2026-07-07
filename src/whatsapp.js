// Gerenciador de sessoes WhatsApp (Baileys). 1 socket por account (numero).
// Multi-usuario: cada account pertence a um owner; eventos saem com {owner, accountId}.
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  downloadMediaMessage,
  BufferJSON,
} from '@whiskeysockets/baileys';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import QRCode from 'qrcode';
import pino from 'pino';
import { mkdirSync, rmSync } from 'node:fs';
import { config, accountAuthDir } from './config.js';
import { store } from './store.js';
import { bus } from './bus.js';
import { suggestReply } from './llm.js';
import { useS3AuthState, deleteS3Auth } from './s3auth.js';

// Carrega o auth state: S3 (duravel) se WA_AUTH_BUCKET setado, senao disco local.
async function loadAuthState(accountId) {
  if (config.authBucket) return useS3AuthState(accountId);
  const dir = accountAuthDir(accountId);
  mkdirSync(dir, { recursive: true });
  return useMultiFileAuthState(dir);
}

const logger = pino({ level: 'warn' });

// accountId -> { sock, status, qrDataUrl }
const sessions = new Map();
const connecting = new Set(); // guard single-flight de reconnect por account

const s3 = new S3Client({ region: config.awsRegion });

// Desembrulha mensagens temporarias/viewOnce e devolve o no de conteudo interno.
function unwrap(message) {
  let m = message;
  if (!m) return null;
  return m.ephemeralMessage?.message || m.viewOnceMessage?.message ||
         m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message || m;
}

// Metadados de midia (ou null se for texto).
function mediaInfo(m) {
  if (!m) return null;
  if (m.imageMessage) return { type: 'image', mime: m.imageMessage.mimetype || 'image/jpeg', name: null, caption: m.imageMessage.caption || '' };
  if (m.stickerMessage) return { type: 'sticker', mime: m.stickerMessage.mimetype || 'image/webp', name: null, caption: '' };
  if (m.videoMessage) return { type: m.videoMessage.gifPlayback ? 'gif' : 'video', mime: m.videoMessage.mimetype || 'video/mp4', name: null, caption: m.videoMessage.caption || '' };
  if (m.audioMessage) return { type: 'audio', mime: m.audioMessage.mimetype || 'audio/ogg', name: null, caption: '' };
  if (m.documentMessage) return { type: 'document', mime: m.documentMessage.mimetype || 'application/octet-stream', name: m.documentMessage.fileName || 'documento', caption: m.documentMessage.caption || '' };
  return null;
}

// Texto da mensagem ou um rotulo de midia.
const extractText = (msg) => {
  const m = unwrap(msg.message);
  if (!m) return '';
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return m.imageMessage.caption || '📷 Foto';
  if (m.videoMessage) return m.videoMessage.caption || (m.videoMessage.gifPlayback ? '🎞️ GIF' : '🎥 Vídeo');
  if (m.stickerMessage) return '🔖 Figurinha';
  if (m.audioMessage) return m.audioMessage.ptt ? '🎤 Mensagem de voz' : '🎵 Áudio';
  if (m.documentMessage) return '📄 ' + (m.documentMessage.fileName || 'Documento');
  if (m.contactMessage || m.contactsArrayMessage) return '👤 Contato';
  if (m.locationMessage || m.liveLocationMessage) return '📍 Localização';
  if (m.pollCreationMessage || m.pollCreationMessageV3) return '📊 Enquete';
  return '';
};
const isGroup = (jid) => jid?.endsWith('@g.us');
const isStatus = (jid) => jid === 'status@broadcast';

// Normaliza um "phone number" do WhatsApp para jid canonico ...@s.whatsapp.net
function normalizePn(pn) {
  if (!pn) return null;
  let s = String(pn);
  if (!s.includes('@')) s = s.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
  return s.replace(/:\d+@/, '@'); // remove sufixo de device
}

// Dado o key de uma mensagem, devolve o jid canonico (resolve @lid -> telefone).
function canonicalJid(accountId, key) {
  let jid = key?.remoteJid;
  if (jid?.endsWith('@lid')) {
    const pnJid = normalizePn(key.senderPn);
    if (pnJid) { store.setLidMap(accountId, jid, pnJid); jid = pnJid; }
    else jid = store.resolveLid(accountId, jid);
  }
  return jid;
}
const tsMs = (t) => (t && typeof t === 'object' && t.toNumber ? t.toNumber() : Number(t || 0)) * 1000 || Date.now();

// Ingestao do history sync que o WhatsApp envia ao parear (messaging-history.set).
function ingestHistory(account, { contacts = [], messages = [] }) {
  const names = {};
  for (const c of contacts) {
    const nm = c.name || c.verifiedName || c.notify || null;
    names[c.id] = nm;
    if (c.id && nm) store.upsertContact(account.id, c.id, nm);
  }
  let n = 0;
  const jids = new Set();
  for (const m of messages) {
    const rawJid = m.key?.remoteJid;
    if (!rawJid || isStatus(rawJid)) continue;
    if (config.ignoreGroups && isGroup(rawJid)) continue;
    const jid = canonicalJid(account.id, m.key);
    const body = extractText(m).trim();
    if (!body) continue;
    const fromMe = !!m.key.fromMe;
    const senderName = fromMe ? 'EU' : (names[rawJid] || names[jid] || m.pushName || jid.split('@')[0]);
    store.addMessage({ accountId: account.id, waId: m.key.id, jid, fromMe, senderName, body, ts: tsMs(m.messageTimestamp) });
    jids.add(jid);
    n++;
  }
  if (n) {
    console.log(`[wa:${account.id.slice(0, 8)}] historico sync: +${n} msgs em ${jids.size} chats`);
    bus.emit('message', { owner: account.owner, accountId: account.id, jid: null });
  }
}

function setStatus(accountId, status, extra = {}) {
  const s = sessions.get(accountId);
  if (s) s.status = status;
  store.setAccountStatus(accountId, status);
  const acct = store.getAccount(accountId);
  bus.emit('wa-status', { owner: acct?.owner, accountId, status, ...extra });
}

const HIST = 30; // quantas msgs do chat ler para entender o que ficou em aberto

async function buildSuggestion(account, jid, history) {
  const lastIncoming = [...history].reverse().find((m) => !m.from_me);
  const chatName = store.contactName(account.id, jid) || lastIncoming?.sender_name || jid.split('@')[0];
  const chatStyleSamples = store.recentOutgoingInChat(account.id, jid, 30);
  const globalStyleSamples = store.recentOutgoing(account.id, 40);
  const suggestion = await suggestReply({ chatName, messages: history, chatStyleSamples, globalStyleSamples });
  store.supersedePending(account.id, jid);
  const row = store.addSuggestion({
    accountId: account.id, owner: account.owner, jid, chatName,
    triggerMsg: lastIncoming?.body || '', suggestion,
  });
  bus.emit('suggestion', row);
  return row;
}

// Gera sob demanda (ao abrir o chat). FinOps: so paga pelos chats que voce engaja.
// Cache: reusa a sugestao pendente se ela foi criada DEPOIS da ultima msg recebida.
export async function suggestForChat(accountId, jid) {
  const account = store.getAccount(accountId);
  if (!account) return null;
  const history = store.recentMessages(accountId, jid, HIST);
  if (!history.length) return null;
  if (history[history.length - 1].from_me) return null; // ja respondido
  const lastIncomingTs = [...history].reverse().find((m) => !m.from_me)?.ts || 0;
  const pending = store.pendingForChat(accountId, jid);
  if (pending && pending.created_at >= lastIncomingTs) return pending; // cache hit -> sem custo
  try {
    const row = await buildSuggestion(account, jid, history);
    console.log(`[wa:${accountId.slice(0, 8)}] sugestao #${row.id} (on-open)`);
    return row;
  } catch (err) {
    console.error(`[wa:${accountId.slice(0, 8)}] falha sugestao:`, err.message);
    return null;
  }
}

async function handleIncoming(account, msg) {
  const rawJid = msg.key.remoteJid;
  if (!rawJid || isStatus(rawJid)) return;
  if (config.ignoreGroups && isGroup(rawJid)) return;
  const jid = canonicalJid(account.id, msg.key);

  const fromMe = !!msg.key.fromMe;
  const bodyText = extractText(msg).trim();
  if (!bodyText) return;

  const senderName = msg.pushName || jid.split('@')[0];
  const ts = (Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000;
  store.addMessage({ accountId: account.id, waId: msg.key.id, jid, fromMe, senderName, body: bodyText, ts });

  // Se for midia, guarda metadados + proto p/ download sob demanda depois.
  const media = mediaInfo(unwrap(msg.message));
  if (media && msg.key.id) {
    const payload = JSON.stringify({ key: msg.key, message: unwrap(msg.message) }, BufferJSON.replacer);
    store.addMedia({ accountId: account.id, waId: msg.key.id, ...media, payload });
  }

  bus.emit('message', { owner: account.owner, accountId: account.id, jid });

  if (fromMe) return;
  bus.emit('incoming', { owner: account.owner, chatName: senderName, body: bodyText }); // -> push (sem LLM)
  // sugestao NAO e gerada aqui (FinOps) — so quando o chat e aberto (suggestForChat).
}

export async function startSession(accountId) {
  const account = store.getAccount(accountId);
  if (!account) throw new Error('account inexistente');
  const existing = sessions.get(accountId);
  if (existing?.status === 'open') return existing;
  if (connecting.has(accountId)) return existing; // reconnect ja em andamento -> evita socket duplicado
  connecting.add(accountId);

  // encerra socket antigo antes de criar outro (evita conflito "replaced" / code 440)
  if (existing?.sock) {
    try { existing.sock.ev.removeAllListeners(); existing.sock.end(undefined); } catch {}
  }

  let sock, saveCreds, session;
  try {
    const auth = await loadAuthState(accountId);
    saveCreds = auth.saveCreds;
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
      version, auth: auth.state, logger,
      printQRInTerminal: false, markOnlineOnConnect: false,
      browser: Browsers.ubuntu('WaAssistant'),
      syncFullHistory: true, // pede ao telefone o historico (limitado pelo WhatsApp)
    });
    session = { sock, status: 'closed', qrDataUrl: null };
    sessions.set(accountId, session);
  } finally {
    connecting.delete(accountId);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messaging-history.set', (h) => {
    try { ingestHistory(account, h); } catch (err) { console.error(`[wa:${accountId.slice(0, 8)}] erro history:`, err.message); }
  });

  // nomes de contatos (agenda via app-state / pushName)
  const upsertContacts = (list = []) => {
    let changed = false;
    for (const c of list) {
      const nm = c.name || c.verifiedName || c.notify;
      if (c.id && nm) { store.upsertContact(account.id, c.id, nm); changed = true; }
    }
    if (changed) bus.emit('message', { owner: account.owner, accountId: account.id, jid: null });
  };
  sock.ev.on('contacts.upsert', upsertContacts);
  sock.ev.on('contacts.update', upsertContacts);
  sock.ev.on('contacts.set', ({ contacts }) => upsertContacts(contacts));

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      session.qrDataUrl = await QRCode.toDataURL(qr).catch(() => null);
      setStatus(accountId, 'qr');
    }
    if (connection === 'open') {
      session.qrDataUrl = null;
      setStatus(accountId, 'open');
      console.log(`[wa:${accountId.slice(0, 8)}] conectado ✓`);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      setStatus(accountId, 'closed');
      if (loggedOut) {
        console.log(`[wa:${accountId.slice(0, 8)}] deslogado.`);
        sessions.delete(accountId);
      } else {
        console.log(`[wa:${accountId.slice(0, 8)}] reconectando (code=${code})...`);
        setTimeout(() => startSession(accountId).catch(console.error), 2000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const acct = store.getAccount(accountId); // re-read (label/owner estaveis)
    for (const msg of messages) {
      try {
        await handleIncoming(acct, msg);
      } catch (err) {
        console.error(`[wa:${accountId.slice(0, 8)}] erro handler:`, err.message);
      }
    }
  });

  return session;
}

export function getSession(accountId) {
  return sessions.get(accountId);
}

export function getQR(accountId) {
  return sessions.get(accountId)?.qrDataUrl || null;
}

export async function getProfilePicture(accountId, jid) {
  const s = sessions.get(accountId);
  if (!s?.sock || s.status !== 'open') return null;
  try { return await s.sock.profilePictureUrl(jid, 'preview'); } catch { return null; }
}

// ---- midia: baixa do WhatsApp -> S3 (sob demanda, com dedupe) ----
const mediaInflight = new Map();

async function ensureMedia(accountId, waId) {
  const row = store.getMedia(accountId, waId);
  if (!row || !row.payload) return null;
  if (row.status === 'ready' && row.s3_key) return row;
  if (row.status === 'failed') return null;
  if (!config.authBucket) return null;
  const k = accountId + '|' + waId;
  if (mediaInflight.has(k)) return mediaInflight.get(k);

  const job = (async () => {
    try {
      const waMsg = JSON.parse(row.payload, BufferJSON.reviver);
      const sess = sessions.get(accountId);
      const buf = await downloadMediaMessage(waMsg, 'buffer', {}, {
        logger,
        reuploadRequest: sess?.sock?.updateMediaMessage?.bind(sess.sock),
      });
      const s3Key = `media/${accountId}/${waId}`;
      await s3.send(new PutObjectCommand({ Bucket: config.authBucket, Key: s3Key, Body: buf, ContentType: row.mime || 'application/octet-stream' }));
      store.mediaReady(accountId, waId, s3Key);
      return { ...row, status: 'ready', s3_key: s3Key };
    } catch (err) {
      console.error(`[wa:${accountId.slice(0, 8)}] midia ${waId} falhou:`, err.message);
      store.mediaFailed(accountId, waId);
      return null;
    } finally {
      mediaInflight.delete(k);
    }
  })();
  mediaInflight.set(k, job);
  return job;
}

export async function getMediaStream(accountId, waId) {
  const row = await ensureMedia(accountId, waId);
  if (!row) return null;
  const r = await s3.send(new GetObjectCommand({ Bucket: config.authBucket, Key: row.s3_key }));
  return { body: r.Body, mime: row.mime, name: row.name };
}

export async function stopSession(accountId, { logout = false } = {}) {
  const s = sessions.get(accountId);
  if (s?.sock) {
    try {
      if (logout) await s.sock.logout();
      else s.sock.end(undefined);
    } catch {}
  }
  sessions.delete(accountId);
  if (logout) {
    if (config.authBucket) await deleteS3Auth(accountId).catch(() => {});
    else try { rmSync(accountAuthDir(accountId), { recursive: true, force: true }); } catch {}
  }
}

export async function sendFromAccount(accountId, jid, text) {
  let s = sessions.get(accountId);
  if (!s || s.status !== 'open') {
    // pode estar em reconnect (408/440) — dispara e aguarda ate ~12s
    startSession(accountId).catch(() => {});
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      s = sessions.get(accountId);
      if (s?.status === 'open') break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  s = sessions.get(accountId);
  if (!s?.sock || s.status !== 'open') throw new Error('numero reconectando — tente de novo em alguns segundos');
  const sent = await s.sock.sendMessage(jid, { text });
  // usa o id real da msg p/ dedupar com o echo do WhatsApp (messages.upsert fromMe)
  store.addMessage({ accountId, waId: sent?.key?.id || null, jid, fromMe: true, senderName: 'EU', body: text, ts: Date.now() });
  bus.emit('message', { owner: store.getAccount(accountId)?.owner, accountId, jid });
}

// Boot: restaura todas as sessoes que ja tem credencial salva.
export async function restoreAllSessions() {
  const accounts = store.listAllAccounts();
  console.log(`[wa] restaurando ${accounts.length} sessao(oes)...`);
  for (const a of accounts) {
    try {
      await startSession(a.id);
    } catch (err) {
      console.error(`[wa] falha ao restaurar ${a.id.slice(0, 8)}:`, err.message);
    }
  }
}
