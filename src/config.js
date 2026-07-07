// Carrega .env (nativo do Node >=22) e exporta config tipada.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const bool = (v, def) => (v == null ? def : /^(1|true|yes)$/i.test(v));

export const config = {
  root,
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  bedrockModel: process.env.BEDROCK_MODEL || 'us.anthropic.claude-sonnet-4-6',
  authBucket: process.env.WA_AUTH_BUCKET || '', // vazio = creds Baileys em disco local
  vapidPublic: process.env.VAPID_PUBLIC || '',
  vapidPrivate: process.env.VAPID_PRIVATE || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@waassistant.local',
  jwtSecret: process.env.JWT_SECRET || 'dev-insecure-change-me',
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  port: Number(process.env.PORT || 3000),
  ignoreGroups: bool(process.env.IGNORE_GROUPS, true),
  contextWindow: Number(process.env.CONTEXT_WINDOW || 15),
  persona:
    process.env.PERSONA ||
    'Responda de forma educada, direta e amigavel, em portugues do Brasil, como se fosse eu.',
  paths: {
    data: join(root, 'data'),
    db: join(root, 'data', 'assistant.db'),
    auth: join(root, 'data', 'auth'), // creds Baileys por account: data/auth/<accountId>/
  },
};

export const accountAuthDir = (accountId) => join(config.paths.auth, accountId);

if (config.jwtSecret === 'dev-insecure-change-me') {
  console.warn('[config] JWT_SECRET nao definido — usando default INSEGURO. Defina JWT_SECRET no .env para producao.');
}
