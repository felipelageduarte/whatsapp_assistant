// Auth sem libs (mesmo padrao do projeto mindmap): scrypt p/ senha, JWT HS256.
// Backed por SQLite (store.js). 1o cadastro = admin aprovado; demais aguardam aprovacao.
import crypto from 'node:crypto';
import { config } from './config.js';
import { store } from './store.js';

const SECRET = config.jwtSecret;

/* ---- senha (scrypt) ---- */
export const hashPw = (pw) => {
  const s = crypto.randomBytes(16);
  return s.toString('hex') + ':' + crypto.scryptSync(pw, s, 64).toString('hex');
};
export const verifyPw = (pw, stored) => {
  const [s, h] = String(stored).split(':');
  if (!s || !h) return false;
  const dk = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
  const hb = Buffer.from(h, 'hex');
  return dk.length === hb.length && crypto.timingSafeEqual(dk, hb);
};

/* ---- JWT HS256 ---- */
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const sign = (payload) => {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ ...payload, iat: now, exp: now + 60 * 60 * 24 * 30 });
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64url');
  return `${h}.${p}.${sig}`;
};
export const verify = (t) => {
  if (!t) return null;
  const [h, p, s] = t.split('.');
  if (!h || !p || !s) return null;
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64url');
  const a = Buffer.from(s), b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
};

export const pub = (u) => ({
  email: u.email,
  name: u.name,
  role: u.role,
  approved: u.approved !== 0 && u.approved !== false,
  telegram_chat_id: u.telegram_chat_id || null,
  createdAt: u.created_at,
});
export const tokenFor = (u) => sign({ email: u.email, name: u.name, role: u.role });

/* ---- handlers (retornam {code, body}) ---- */
export function register({ email, password, name }) {
  email = (email || '').toLowerCase().trim();
  if (!email || !password) return { code: 400, body: { error: 'email e senha sao obrigatorios' } };
  if (password.length < 6) return { code: 400, body: { error: 'senha minima de 6 caracteres' } };
  if (store.getUser(email)) return { code: 409, body: { error: 'email ja cadastrado' } };

  const first = store.countUsers() === 0;
  const u = store.createUser({
    email,
    name: name || email,
    role: first ? 'admin' : 'user',
    passwordHash: hashPw(password),
    approved: first,
  });
  if (!first) return { code: 200, body: { pending: true } };
  return { code: 200, body: { token: tokenFor(u), user: pub(u) } };
}

export function login({ email, password }) {
  email = (email || '').toLowerCase().trim();
  const u = store.getUser(email);
  if (!u || !verifyPw(password || '', u.password_hash))
    return { code: 401, body: { error: 'email ou senha invalidos' } };
  if (u.approved === 0) return { code: 403, body: { error: 'Conta aguardando aprovacao do administrador.' } };
  return { code: 200, body: { token: tokenFor(u), user: pub(u) } };
}

// Middleware Express: popula req.user a partir do Bearer token.
export function authMiddleware(req, res, next) {
  const raw = (req.headers.authorization || '').replace(/^Bearer /, '');
  const payload = verify(raw);
  if (!payload) return res.status(401).json({ error: 'nao autenticado' });
  const u = store.getUser(payload.email);
  if (!u || u.approved === 0) return res.status(403).json({ error: 'conta invalida ou nao aprovada' });
  req.user = u;
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'requer admin' });
  next();
}
