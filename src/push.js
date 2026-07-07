// Web Push (VAPID): notifica o dono quando chega mensagem nova.
// Funciona no browser desktop e em PWA instalado no iPhone (iOS 16.4+),
// que por sua vez espelha a notificacao no Apple Watch automaticamente.
import webpush from 'web-push';
import { config } from './config.js';
import { store } from './store.js';
import { bus } from './bus.js';

let enabled = false;

export function initPush() {
  if (!config.vapidPublic || !config.vapidPrivate) {
    console.log('[push] VAPID ausente — push desativado.');
    return;
  }
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublic, config.vapidPrivate);
  enabled = true;

  bus.on('incoming', async ({ owner, chatName, body }) => {
    const subs = store.listSubs(owner);
    if (!subs.length) return;
    const payload = JSON.stringify({ title: chatName || 'Nova mensagem', body: String(body || '').slice(0, 180) });
    await Promise.all(subs.map((s) =>
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
        .catch((err) => { if (err.statusCode === 404 || err.statusCode === 410) store.delSub(s.endpoint); })
    ));
  });

  console.log('[push] web-push ativo.');
}

export const pushEnabled = () => enabled;
