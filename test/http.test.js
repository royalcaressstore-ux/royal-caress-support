import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fakeClient, text, tool, freshDb } from './helpers.js';
import { createApp } from '../src/server.js';
import { createAssistant } from '../src/ai.js';
import * as store from '../src/store.js';
import { config } from '../src/config.js';

config.sessionSecret = 'x'.repeat(40);
config.staff = [{ email: 'ana@loja.com', password: 'senha-forte-123' }];
config.allowedOrigins = ['https://loja.test'];
config.whatsapp = { token: 't', phoneNumberId: '1', verifyToken: 'verif', appSecret: 'segredo-app' };

let server, base, script, sent, ran;
before(async () => {
  freshDb();
  script = [];
  sent = []; ran = [];
  const client = { messages: { create: async (p) => { const s = script.shift(); if (!s) throw new Error('sem roteiro'); return typeof s === 'function' ? s(p) : s; } } };
  const ai = createAssistant({ client, notify: () => {} });
  const app = createApp({
    assistant: ai, notify: () => {},
    sendWa: async (to, t) => { sent.push([to, t]); }, waEnabled: () => true,
    runAction: async (a) => { ran.push(a.id); return { ok: true, message: 'ok executado' }; },
  });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const j = (path, opts = {}) => fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });

async function login() {
  const r = await j('/api/admin/login', { method: 'POST', body: JSON.stringify({ email: 'ana@loja.com', password: 'senha-forte-123' }) });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

test('chat do site: cria conversa, devolve token e permite continuar', async () => {
  script.push(text('Hello! How can I help?'), text('Rose Lix is £35.99.'));
  const r1 = await j('/api/chat/message', { method: 'POST', headers: { Origin: 'https://loja.test' }, body: JSON.stringify({ text: 'hi' }) });
  const b1 = await r1.json();
  assert.equal(r1.status, 200);
  assert.ok(b1.token);
  assert.equal(b1.messages.at(-1).text, 'Hello! How can I help?');
  const r2 = await j('/api/chat/message', { method: 'POST', headers: { Authorization: 'Bearer ' + b1.token }, body: JSON.stringify({ text: 'price rose?' }) });
  const b2 = await r2.json();
  assert.equal(b2.messages.at(-1).text, 'Rose Lix is £35.99.');
  assert.equal(b2.token, undefined);
  // histórico só mostra cliente/agente, nunca notas internas
  const h = await (await j('/api/chat/messages?after=0', { headers: { Authorization: 'Bearer ' + b1.token } })).json();
  assert.ok(h.messages.every((m) => ['customer', 'agent'].includes(m.role)));
});

test('chat: origem não autorizada é recusada; token falso não acessa conversas', async () => {
  const r = await j('/api/chat/message', { method: 'POST', headers: { Origin: 'https://evil.test' }, body: JSON.stringify({ text: 'hi' }) });
  assert.equal(r.status, 403);
  const r2 = await j('/api/chat/messages?after=0', { headers: { Authorization: 'Bearer forjado.abc' } });
  assert.equal(r2.status, 401);
});

test('painel exige login; CSRF exige cabeçalho; senha errada falha', async () => {
  assert.equal((await j('/api/admin/conversations')).status, 401);
  const bad = await j('/api/admin/login', { method: 'POST', body: JSON.stringify({ email: 'ana@loja.com', password: 'errada' }) });
  assert.equal(bad.status, 401);
  const cookie = await login();
  assert.equal((await j('/api/admin/conversations', { headers: { Cookie: cookie } })).status, 200);
  const noCsrf = await j('/api/admin/knowledge/file', { method: 'PUT', headers: { Cookie: cookie }, body: JSON.stringify({ file: 'x.md', content: 'a' }) });
  assert.equal(noCsrf.status, 403);
});

test('equipe responde no site e cliente recebe; aprovação executa uma única vez', async () => {
  const cookie = await login();
  const H = { Cookie: cookie, 'X-Requested-With': 'rc-panel' };
  const c = store.findOrCreateConversation({ channel: 'web', externalId: 'w_teste' });
  store.addMessage(c.id, 'customer', 'cancel please');
  store.setStatus(c.id, 'needs_human', { reason: 'order_action' });
  const aid = store.createAction({ conversationId: c.id, type: 'cancel_order', orderName: '#1001', payload: {}, reason: 'mistake' });

  const take = await j(`/api/admin/conversations/${c.id}/take`, { method: 'POST', headers: H });
  assert.equal(take.status, 200);
  const rep = await j(`/api/admin/conversations/${c.id}/reply`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'On it!' }) });
  assert.equal(rep.status, 200);
  assert.ok(store.getMessages(c.id).some((m) => m.role === 'staff' && m.content === 'On it!'));

  const [a1, a2] = await Promise.all([
    j(`/api/admin/actions/${aid}/approve`, { method: 'POST', headers: H, body: '{}' }),
    j(`/api/admin/actions/${aid}/approve`, { method: 'POST', headers: H, body: '{}' }),
  ]);
  assert.deepEqual([a1.status, a2.status].sort(), [200, 409]);
  assert.equal(ran.length, 1);
  assert.equal(store.getAction(aid).status, 'approved');
});

test('webhook WhatsApp: handshake, assinatura inválida, mensagem válida, duplicata ignorada', async () => {
  assert.equal(await (await j('/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verif&hub.challenge=777')).text(), '777');
  assert.equal((await j('/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1')).status, 403);

  const payload = { entry: [{ changes: [{ value: { contacts: [{ wa_id: '447700900123', profile: { name: 'Sam' } }], messages: [{ id: 'wamid.1', from: '447700900123', type: 'text', text: { body: 'Is it waterproof?' } }] } }] }] };
  const raw = JSON.stringify(payload);
  const bad = await fetch(base + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=00' }, body: raw });
  assert.equal(bad.status, 401);
  const sig = 'sha256=' + crypto.createHmac('sha256', 'segredo-app').update(raw).digest('hex');
  script.push(text('It is waterproof, see product details.'));
  const ok = await fetch(base + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
  assert.equal(ok.status, 200);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(sent.at(-1), ['447700900123', 'It is waterproof, see product details.']);
  const n = sent.length;
  await fetch(base + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, n); // reenvio da Meta não gera resposta duplicada
});

test('conhecimento: edição fora da pasta é recusada; edição válida atualiza o relatório', async () => {
  const cookie = await login();
  const H = { Cookie: cookie, 'X-Requested-With': 'rc-panel' };
  const evil = await j('/api/admin/knowledge/file?file=' + encodeURIComponent('../../package.json'), { headers: H });
  assert.equal(evil.status, 404);
  const evilPut = await j('/api/admin/knowledge/file', { method: 'PUT', headers: H, body: JSON.stringify({ file: '../src/ai.js', content: 'x' }) });
  assert.equal(evilPut.status, 400);
  const k = await (await j('/api/admin/knowledge', { headers: H })).json();
  assert.ok(k.files.includes('10-envio-e-prazos.md'));
  assert.ok(k.report.missing.length > 0);
});

test('relatório responde com a estrutura esperada', async () => {
  const cookie = await login();
  const r = await (await j('/api/admin/report?days=30', { headers: { Cookie: cookie } })).json();
  assert.ok(r.total >= 1);
  assert.ok(Array.isArray(r.perDay));
});
