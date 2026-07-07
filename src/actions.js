// Acoes compartilhadas por TODOS os frontends (Telegram e Web).
// Regra unica: nada envia sem aprovacao; sempre valida posse (owner) da sugestao.
import { store } from './store.js';
import { bus } from './bus.js';
import { sendFromAccount } from './whatsapp.js';

function ownedSuggestion(id, owner) {
  const s = store.getSuggestion(id);
  if (!s) throw new Error('sugestao nao encontrada');
  if (owner && s.owner !== owner) throw new Error('sem permissao');
  return s;
}

export async function approveSuggestion(id, { owner, editedText } = {}) {
  const s = ownedSuggestion(id, owner);
  if (s.status !== 'pending') throw new Error(`sugestao ja ${s.status}`);
  const text = (editedText ?? s.suggestion).trim();
  if (!text) throw new Error('texto vazio');

  await sendFromAccount(s.account_id, s.jid, text);
  const updated = store.setStatus(id, 'sent', text);
  bus.emit('updated', updated);
  return updated;
}

export function rejectSuggestion(id, { owner } = {}) {
  const s = ownedSuggestion(id, owner);
  if (s.status !== 'pending') throw new Error(`sugestao ja ${s.status}`);
  const updated = store.setStatus(id, 'rejected', null);
  bus.emit('updated', updated);
  return updated;
}
