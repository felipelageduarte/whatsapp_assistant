// Persistencia com node:sqlite (nativo). Multi-usuario + multi-numero (account).
// Modelo: user(email) 1---N account(numero WhatsApp) 1---N messages/suggestions.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { config } from './config.js';

mkdirSync(config.paths.data, { recursive: true });

const db = new DatabaseSync(config.paths.db);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email            TEXT PRIMARY KEY,
    name             TEXT,
    role             TEXT NOT NULL DEFAULT 'user',   -- admin|user
    password_hash    TEXT NOT NULL,
    approved         INTEGER NOT NULL DEFAULT 0,
    telegram_chat_id TEXT,
    created_at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id         TEXT PRIMARY KEY,                      -- uuid
    owner      TEXT NOT NULL,                         -- users.email
    label      TEXT,                                  -- apelido do numero
    status     TEXT NOT NULL DEFAULT 'closed',        -- closed|qr|open
    created_at INTEGER NOT NULL,
    FOREIGN KEY (owner) REFERENCES users(email) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner);

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  TEXT NOT NULL,
    wa_id       TEXT,
    jid         TEXT NOT NULL,
    from_me     INTEGER NOT NULL,
    sender_name TEXT,
    body        TEXT,
    ts          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_acct_jid_ts ON messages(account_id, jid, ts);

  CREATE TABLE IF NOT EXISTS contacts (
    account_id TEXT NOT NULL,
    jid        TEXT NOT NULL,
    name       TEXT,
    PRIMARY KEY (account_id, jid)
  );

  CREATE TABLE IF NOT EXISTS media (
    account_id TEXT NOT NULL,
    wa_id      TEXT NOT NULL,
    type       TEXT,
    mime       TEXT,
    name       TEXT,
    caption    TEXT,
    payload    TEXT,
    s3_key     TEXT,
    status     TEXT DEFAULT 'pending',
    created_at INTEGER,
    PRIMARY KEY (account_id, wa_id)
  );

  CREATE TABLE IF NOT EXISTS contact_pics (
    account_id TEXT NOT NULL,
    jid        TEXT NOT NULL,
    url        TEXT,
    ts         INTEGER,
    PRIMARY KEY (account_id, jid)
  );

  CREATE TABLE IF NOT EXISTS lid_map (
    account_id TEXT NOT NULL,
    lid        TEXT NOT NULL,
    pn         TEXT NOT NULL,
    PRIMARY KEY (account_id, lid)
  );

  CREATE TABLE IF NOT EXISTS push_subs (
    endpoint   TEXT PRIMARY KEY,
    owner      TEXT NOT NULL,
    p256dh     TEXT,
    auth       TEXT,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_push_owner ON push_subs(owner);

  CREATE TABLE IF NOT EXISTS suggestions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  TEXT NOT NULL,
    owner       TEXT NOT NULL,                        -- denormalizado p/ escopo/SSE
    jid         TEXT NOT NULL,
    chat_name   TEXT,
    trigger_msg TEXT,
    suggestion  TEXT NOT NULL,
    final_text  TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',      -- pending|sent|rejected
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_suggestions_owner ON suggestions(owner, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_suggestions_acct ON suggestions(account_id, status, created_at);
`);

// Indice unico p/ dedup do history sync. Em DB legado com wa_id duplicado,
// remove os duplicados antes de criar (mantem o menor id).
try {
  db.exec(`DELETE FROM messages WHERE wa_id IS NOT NULL AND id NOT IN (
    SELECT MIN(id) FROM messages WHERE wa_id IS NOT NULL GROUP BY account_id, wa_id);`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_waid ON messages(account_id, wa_id) WHERE wa_id IS NOT NULL;`);
} catch (err) {
  console.warn('[store] indice unico wa_id nao criado:', err.message);
}

const now = () => Date.now();

const stmt = {
  // users
  countUsers: db.prepare(`SELECT COUNT(*) AS n FROM users`),
  insertUser: db.prepare(
    `INSERT INTO users (email, name, role, password_hash, approved, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ),
  getUser: db.prepare(`SELECT * FROM users WHERE email = ?`),
  listUsers: db.prepare(`SELECT * FROM users ORDER BY created_at ASC`),
  setApproved: db.prepare(`UPDATE users SET approved = ? WHERE email = ?`),
  setRole: db.prepare(`UPDATE users SET role = ? WHERE email = ?`),
  setTelegram: db.prepare(`UPDATE users SET telegram_chat_id = ? WHERE email = ?`),
  getUserByTelegram: db.prepare(`SELECT * FROM users WHERE telegram_chat_id = ?`),
  deleteUser: db.prepare(`DELETE FROM users WHERE email = ?`),

  // accounts
  insertAccount: db.prepare(
    `INSERT INTO accounts (id, owner, label, status, created_at) VALUES (?, ?, ?, 'closed', ?)`
  ),
  getAccount: db.prepare(`SELECT * FROM accounts WHERE id = ?`),
  listAccountsByOwner: db.prepare(`SELECT * FROM accounts WHERE owner = ? ORDER BY created_at ASC`),
  listAllAccounts: db.prepare(`SELECT * FROM accounts ORDER BY created_at ASC`),
  setAccountStatus: db.prepare(`UPDATE accounts SET status = ? WHERE id = ?`),
  setAccountLabel: db.prepare(`UPDATE accounts SET label = ? WHERE id = ?`),
  deleteAccount: db.prepare(`DELETE FROM accounts WHERE id = ?`),

  // messages
  insertMessage: db.prepare(
    `INSERT OR IGNORE INTO messages (account_id, wa_id, jid, from_me, sender_name, body, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  recentMessages: db.prepare(
    `SELECT * FROM (
       SELECT * FROM messages WHERE account_id = ? AND jid = ? ORDER BY ts DESC LIMIT ?
     ) ORDER BY ts ASC`
  ),
  // amostra do estilo de escrita do dono (mensagens enviadas por ele)
  recentOutgoing: db.prepare(
    `SELECT DISTINCT body FROM messages
     WHERE account_id = ? AND from_me = 1 AND length(trim(body)) > 0
     ORDER BY ts DESC LIMIT ?`
  ),
  // estilo do dono NESTE chat (como ele fala com essa pessoa especificamente)
  recentOutgoingInChat: db.prepare(
    `SELECT DISTINCT body FROM messages
     WHERE account_id = ? AND jid = ? AND from_me = 1 AND length(trim(body)) > 0
     ORDER BY ts DESC LIMIT ?`
  ),
  contactName: db.prepare(`SELECT name FROM contacts WHERE account_id=? AND jid=?`),
  supersedePending: db.prepare(
    `UPDATE suggestions SET status='rejected', updated_at=? WHERE account_id=? AND jid=? AND status='pending'`
  ),

  // suggestions
  insertSuggestion: db.prepare(
    `INSERT INTO suggestions (account_id, owner, jid, chat_name, trigger_msg, suggestion, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ),
  getSuggestion: db.prepare(`SELECT * FROM suggestions WHERE id = ?`),
  listByOwner: db.prepare(
    `SELECT * FROM suggestions WHERE owner = ? ORDER BY created_at DESC LIMIT ?`
  ),
  listByOwnerStatus: db.prepare(
    `SELECT * FROM suggestions WHERE owner = ? AND status = ? ORDER BY created_at DESC LIMIT ?`
  ),
  updateStatus: db.prepare(
    `UPDATE suggestions SET status = ?, final_text = ?, updated_at = ? WHERE id = ?`
  ),

  // contatos (nome salvo / pushName)
  upsertContact: db.prepare(
    `INSERT INTO contacts (account_id, jid, name) VALUES (?, ?, ?)
     ON CONFLICT(account_id, jid) DO UPDATE SET name=excluded.name WHERE excluded.name IS NOT NULL AND excluded.name<>''`
  ),

  // chats (conversas agregadas por jid dentro de uma account)
  listChats: db.prepare(
    `SELECT m.jid,
        MAX(m.ts) AS last_ts,
        (SELECT body FROM messages WHERE account_id=m.account_id AND jid=m.jid ORDER BY ts DESC LIMIT 1) AS last_body,
        (SELECT from_me FROM messages WHERE account_id=m.account_id AND jid=m.jid ORDER BY ts DESC LIMIT 1) AS last_from_me,
        COALESCE(
          (SELECT name FROM contacts WHERE account_id=m.account_id AND jid=m.jid),
          (SELECT sender_name FROM messages WHERE account_id=m.account_id AND jid=m.jid AND from_me=0 AND sender_name IS NOT NULL ORDER BY ts DESC LIMIT 1)
        ) AS name,
        (SELECT id FROM suggestions WHERE account_id=m.account_id AND jid=m.jid AND status='pending' ORDER BY created_at DESC LIMIT 1) AS pending_id,
        (SELECT suggestion FROM suggestions WHERE account_id=m.account_id AND jid=m.jid AND status='pending' ORDER BY created_at DESC LIMIT 1) AS pending_text
     FROM messages m WHERE m.account_id=?
     GROUP BY m.jid ORDER BY last_ts DESC LIMIT 200`
  ),
  chatMessages: db.prepare(
    `SELECT * FROM (
       SELECT m.id, m.wa_id, m.from_me, m.sender_name, m.body, m.ts,
              med.type AS media_type, med.mime AS media_mime, med.name AS media_name, med.caption AS media_caption
       FROM messages m
       LEFT JOIN media med ON med.account_id=m.account_id AND med.wa_id=m.wa_id
       WHERE m.account_id=? AND m.jid=? ORDER BY m.ts DESC LIMIT ?
     ) ORDER BY ts ASC`
  ),
  pendingForChat: db.prepare(
    `SELECT * FROM suggestions WHERE account_id=? AND jid=? AND status='pending' ORDER BY created_at DESC LIMIT 1`
  ),

  // push
  insertSub: db.prepare(
    `INSERT OR REPLACE INTO push_subs (endpoint, owner, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)`
  ),
  listSubs: db.prepare(`SELECT * FROM push_subs WHERE owner=?`),
  delSub: db.prepare(`DELETE FROM push_subs WHERE endpoint=?`),

  // LID <-> telefone (WhatsApp passou a endereçar por @lid)
  insertLid: db.prepare(`INSERT OR REPLACE INTO lid_map (account_id, lid, pn) VALUES (?, ?, ?)`),
  getLid: db.prepare(`SELECT pn FROM lid_map WHERE account_id=? AND lid=?`),
  migMsgs: db.prepare(`UPDATE OR IGNORE messages SET jid=? WHERE account_id=? AND jid=?`),
  migContacts: db.prepare(`UPDATE OR IGNORE contacts SET jid=? WHERE account_id=? AND jid=?`),
  migSugg: db.prepare(`UPDATE suggestions SET jid=? WHERE account_id=? AND jid=?`),

  // fotos de perfil
  getPic: db.prepare(`SELECT url, ts FROM contact_pics WHERE account_id=? AND jid=?`),
  setPic: db.prepare(`INSERT OR REPLACE INTO contact_pics (account_id, jid, url, ts) VALUES (?, ?, ?, ?)`),

  // midia
  insertMedia: db.prepare(
    `INSERT OR IGNORE INTO media (account_id, wa_id, type, mime, name, caption, payload, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ),
  getMedia: db.prepare(`SELECT * FROM media WHERE account_id=? AND wa_id=?`),
  mediaReady: db.prepare(`UPDATE media SET status='ready', s3_key=? WHERE account_id=? AND wa_id=?`),
  mediaFailed: db.prepare(`UPDATE media SET status='failed' WHERE account_id=? AND wa_id=?`),
};

export const store = {
  // ---- users ----
  countUsers: () => stmt.countUsers.get().n,
  createUser({ email, name, role, passwordHash, approved }) {
    stmt.insertUser.run(email, name ?? email, role, passwordHash, approved ? 1 : 0, now());
    return stmt.getUser.get(email);
  },
  getUser: (email) => stmt.getUser.get(email),
  getUserByTelegram: (chatId) => stmt.getUserByTelegram.get(String(chatId)),
  listUsers: () => stmt.listUsers.all(),
  setApproved: (email, v) => (stmt.setApproved.run(v ? 1 : 0, email), stmt.getUser.get(email)),
  setRole: (email, role) => (stmt.setRole.run(role, email), stmt.getUser.get(email)),
  setTelegram: (email, chatId) => (stmt.setTelegram.run(chatId ?? null, email), stmt.getUser.get(email)),
  deleteUser: (email) => stmt.deleteUser.run(email),

  // ---- accounts ----
  createAccount({ id, owner, label }) {
    stmt.insertAccount.run(id, owner, label ?? null, now());
    return stmt.getAccount.get(id);
  },
  getAccount: (id) => stmt.getAccount.get(id),
  listAccounts: (owner) => stmt.listAccountsByOwner.all(owner),
  listAllAccounts: () => stmt.listAllAccounts.all(),
  setAccountStatus: (id, status) => stmt.setAccountStatus.run(status, id),
  setAccountLabel: (id, label) => (stmt.setAccountLabel.run(label, id), stmt.getAccount.get(id)),
  deleteAccount: (id) => stmt.deleteAccount.run(id),

  // ---- messages ----
  addMessage({ accountId, waId, jid, fromMe, senderName, body, ts }) {
    const r = stmt.insertMessage.run(accountId, waId ?? null, jid, fromMe ? 1 : 0, senderName ?? null, body ?? '', ts ?? now());
    return Number(r.lastInsertRowid);
  },
  recentMessages: (accountId, jid, limit) => stmt.recentMessages.all(accountId, jid, limit),
  recentOutgoing: (accountId, limit = 60) => stmt.recentOutgoing.all(accountId, limit).map((r) => r.body),
  recentOutgoingInChat: (accountId, jid, limit = 40) => stmt.recentOutgoingInChat.all(accountId, jid, limit).map((r) => r.body),
  contactName: (accountId, jid) => stmt.contactName.get(accountId, jid)?.name || null,
  supersedePending: (accountId, jid) => stmt.supersedePending.run(Date.now(), accountId, jid),

  // ---- suggestions ----
  addSuggestion({ accountId, owner, jid, chatName, triggerMsg, suggestion }) {
    const t = now();
    const r = stmt.insertSuggestion.run(accountId, owner, jid, chatName ?? null, triggerMsg ?? '', suggestion, t, t);
    return stmt.getSuggestion.get(Number(r.lastInsertRowid));
  },
  getSuggestion: (id) => stmt.getSuggestion.get(id),
  listSuggestions({ owner, status, limit = 50 }) {
    return status
      ? stmt.listByOwnerStatus.all(owner, status, limit)
      : stmt.listByOwner.all(owner, limit);
  },
  setStatus(id, status, finalText = null) {
    stmt.updateStatus.run(status, finalText, now(), id);
    return stmt.getSuggestion.get(id);
  },

  // ---- contatos ----
  upsertContact(accountId, jid, name) {
    if (!jid || !name) return;
    try { stmt.upsertContact.run(accountId, jid, String(name).trim()); } catch {}
  },

  // ---- chats ----
  listChats: (accountId) => stmt.listChats.all(accountId),
  chatMessages: (accountId, jid, limit = 50) => stmt.chatMessages.all(accountId, jid, limit),
  pendingForChat: (accountId, jid) => stmt.pendingForChat.get(accountId, jid),

  // ---- push ----
  addSub(owner, sub) {
    if (!sub?.endpoint) return;
    stmt.insertSub.run(sub.endpoint, owner, sub.keys?.p256dh ?? null, sub.keys?.auth ?? null, now());
  },
  listSubs: (owner) => stmt.listSubs.all(owner),
  delSub: (endpoint) => stmt.delSub.run(endpoint),

  // ---- LID mapping ----
  resolveLid(accountId, jid) {
    if (!jid || !jid.endsWith('@lid')) return jid;
    return stmt.getLid.get(accountId, jid)?.pn || jid;
  },
  // ---- fotos ----
  getPic: (accountId, jid) => stmt.getPic.get(accountId, jid),
  setPic: (accountId, jid, url) => stmt.setPic.run(accountId, jid, url || '', Date.now()),

  // ---- midia ----
  addMedia({ accountId, waId, type, mime, name, caption, payload }) {
    if (!waId) return;
    stmt.insertMedia.run(accountId, waId, type, mime ?? null, name ?? null, caption ?? null, payload ?? null, Date.now());
  },
  getMedia: (accountId, waId) => stmt.getMedia.get(accountId, waId),
  mediaReady: (accountId, waId, s3Key) => stmt.mediaReady.run(s3Key, accountId, waId),
  mediaFailed: (accountId, waId) => stmt.mediaFailed.run(accountId, waId),

  // Aprende lid->pn e migra mensagens/contatos/sugestoes do chat @lid p/ o telefone.
  setLidMap(accountId, lid, pn) {
    if (!lid || !pn || lid === pn) return;
    stmt.insertLid.run(accountId, lid, pn);
    try {
      stmt.migMsgs.run(pn, accountId, lid);
      stmt.migContacts.run(pn, accountId, lid);
      stmt.migSugg.run(pn, accountId, lid);
    } catch {}
  },
};
