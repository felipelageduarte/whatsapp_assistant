// Bootstrap: API web (auth + accounts) + Telegram + restaura sessoes WhatsApp salvas.
import { startApi } from './api.js';
import { startTelegram } from './telegram.js';
import { restoreAllSessions, sendFromAccount } from './whatsapp.js';
import { initPush } from './push.js';
import { startOutboxPolling, bridgeEnabled } from './bridge.js';

async function main() {
  console.log('== WhatsApp Assistant (multi-user) ==');
  if (bridgeEnabled()) console.log('[bridge] BOTIMOVEL_API_URL setado — rascunho/aprovação delegados ao BotImóvel');
  initPush();
  startApi();
  startTelegram();
  await restoreAllSessions(); // reconecta numeros ja pareados (creds em S3/disco)
  startOutboxPolling(sendFromAccount);
}

main().catch((err) => {
  console.error('Falha fatal:', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\nEncerrando...');
  process.exit(0);
});
