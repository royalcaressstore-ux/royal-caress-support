import crypto from 'node:crypto';
import { config } from './config.js';
import { safeEqual } from './security.js';

export const whatsappEnabled = () => !!(config.whatsapp.token && config.whatsapp.phoneNumberId);

/** Confere a assinatura que a Meta coloca em cada webhook (X-Hub-Signature-256). */
export function validSignature(rawBody, header) {
  if (!config.whatsapp.appSecret || !header || !rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest('hex');
  return safeEqual(expected, header);
}

export async function sendWhatsApp(to, text) {
  if (!whatsappEnabled()) throw new Error('WhatsApp não configurado.');
  const res = await fetch(`https://graph.facebook.com/v21.0/${config.whatsapp.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: String(text).slice(0, 4000), preview_url: false } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WhatsApp HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}

/** Extrai mensagens de um payload do webhook da Meta. */
export function parseWebhook(body) {
  const out = [];
  for (const entry of body?.entry || [])
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages || [])
        out.push({ id: m.id, from: m.from, name: names[m.from], type: m.type, text: m.type === 'text' ? m.text?.body : null });
    }
  return out;
}

export const WINDOW_MS = 24 * 3600 * 1000;
