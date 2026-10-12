import path from 'node:path';
import fs from 'node:fs';

const env = process.env;
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(env.PORT || 3000),
  publicUrl: (env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
  sessionSecret: env.SESSION_SECRET || '',
  allowedOrigins: list(env.ALLOWED_ORIGINS),
  dataDir: path.resolve(env.DATA_DIR || './data'),
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  model: env.CLAUDE_MODEL || 'claude-haiku-5-5',
  maxAiRepliesPerDay: Number(env.MAX_AI_REPLIES_PER_DAY || 300),
  staff: list(env.STAFF_USERS).map((p) => {
    const i = p.indexOf(':');
    return { email: p.slice(0, i).toLowerCase(), password: p.slice(i + 1) };
  }),
  alertEmail: env.ALERT_EMAIL || '',
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || 'atendimento@localhost',
  },
  shopify: {
    store: env.SHOPIFY_STORE || '',
    token: env.SHOPIFY_ADMIN_TOKEN || '',
    clientId: env.SHOPIFY_CLIENT_ID || '',
    clientSecret: env.SHOPIFY_CLIENT_SECRET || '',
    version: env.SHOPIFY_API_VERSION || '2025-10',
  },
  whatsapp: {
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: env.WHATSAPP_APP_SECRET || '',
  },
};

export function validateConfig({ strict }) {
  const problems = [];
  if (!config.sessionSecret || config.sessionSecret === 'troque-isto' || config.sessionSecret.length < 24)
    problems.push('SESSION_SECRET precisa ter pelo menos 24 caracteres e não pode ser o valor de exemplo.');
  if (!config.staff.length) problems.push('STAFF_USERS está vazio: ninguém conseguiria entrar no painel.');
  if (strict) {
    if (!config.anthropicKey) problems.push('ANTHROPIC_API_KEY ausente: a IA não responderá (as conversas irão direto para a equipe).');
  }
  return problems;
}

export function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}
