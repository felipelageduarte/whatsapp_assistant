// Bootstrap: API web (auth + accounts) + Telegram + restaura sessoes WhatsApp salvas.
import { startApi } from './api.js';
import { startTelegram } from './telegram.js';
import { restoreAllSessions } from './whatsapp.js';
import { initPush } from './push.js';

async function main() {
  console.log('== WhatsApp Assistant (multi-user) ==');
  initPush();
  startApi();
  startTelegram();
  await restoreAllSessions(); // reconecta numeros ja pareados (creds em S3/disco)
}

main().catch((err) => {
  console.error('Falha fatal:', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\nEncerrando...');
  process.exit(0);
});
