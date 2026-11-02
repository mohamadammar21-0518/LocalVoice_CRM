import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';

// Exclusive creation: never rotate secrets under an existing database.
const source = dotenv.parse(await readFile('.env.docker'));
if (!source.VOICE_SERVICE_TOKEN) throw new Error('Shared voice service token is missing');
const secret = () => randomBytes(32).toString('hex');
const password = secret();
const settings = {
  NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '3000', APP_ORIGIN: 'https://localhost:3100',
  HTTPS_PORT: '3443', HTTPS_PFX_PATH: '/app/.localvoice-private/tls/localvoice.pfx',
  APP_TIMEZONE: 'Asia/Kuala_Lumpur', TRUST_PROXY: '0',
  MYSQL_PASSWORD: password, MYSQL_ROOT_PASSWORD: secret(),
  DATABASE_URL: `mysql://staging:${password}@localvoice-staging-mysql-1:3306/localvoice_staging`,
  JWT_SECRET: secret(), LOCAL_ADMIN_USERNAME: 'staging_admin', LOCAL_ADMIN_PASSWORD: secret(),
  BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SALESFORCE_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  LOCAL_STORAGE_PATH: '/app/uploads',
  OLLAMA_BASE_URL: 'http://host.docker.internal:11434', OLLAMA_MODEL: source.OLLAMA_MODEL || 'qwen2.5-coder:1.5b',
  WHISPER_MODE: 'fastapi', WHISPER_SERVER_URL: 'http://localvoice-crm1-speech-1:8001',
  TTS_MODE: 'server', TTS_SERVER_URL: 'http://localvoice-crm1-tts-1:8002',
  VOICE_SERVICE_TOKEN: source.VOICE_SERVICE_TOKEN,
};
await writeFile('.env.staging', Object.entries(settings).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
console.log('Created .env.staging with isolated credentials. No production CRM credentials copied.');
