import crypto from 'node:crypto';
import { config } from './config.js';

const b64 = (b) => Buffer.from(b).toString('base64url');
export const hmac = (data) => crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** token = base64url(payload).assinatura  */
export function signToken(payload, ttlMs) {
  const body = b64(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
  return `${body}.${hmac(body)}`;
}
export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!safeEqual(sig, hmac(body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

/** Limitador simples em memória: max tentativas por janela. */
export function makeLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const t = Date.now();
    const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(t); hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
    return true;
  };
}

export function checkStaffLogin(email, password) {
  const u = config.staff.find((s) => s.email === String(email || '').toLowerCase());
  // compara sempre, para não revelar se o e-mail existe pelo tempo de resposta
  const ok = safeEqual(u ? u.password : 'x'.repeat(16), String(password || ''));
  return u && ok ? u.email : null;
}

export function parseCookies(header) {
  return Object.fromEntries(String(header || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
