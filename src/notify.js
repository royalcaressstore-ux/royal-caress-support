import nodemailer from 'nodemailer';
import { config } from './config.js';

let transport;
const lastSent = new Map(); // conversationId -> timestamp (evita enxurrada de avisos)

export function emailEnabled() {
  return !!(config.smtp.host && config.alertEmail);
}

export async function alertTeam({ conversationId, subject, text }) {
  const t = Date.now();
  if (conversationId) {
    const last = lastSent.get(conversationId) || 0;
    if (t - last < 10 * 60 * 1000) return false; // no máx. 1 aviso a cada 10 min por conversa
    lastSent.set(conversationId, t);
  }
  if (!emailEnabled()) {
    console.log(`[AVISO PARA A EQUIPE] ${subject}\n${text}`);
    return false;
  }
  transport ||= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  try {
    await transport.sendMail({
      from: config.smtp.from,
      to: config.alertEmail,
      subject: `[Royal Caress] ${subject}`,
      text: `${text}\n\nAbrir painel: ${config.publicUrl}/admin/`,
    });
    return true;
  } catch (e) {
    console.error('Falha ao enviar e-mail de aviso:', e.message);
    return false;
  }
}
