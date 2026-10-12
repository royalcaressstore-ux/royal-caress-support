import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, validateConfig } from './config.js';
import { openDb, logEvent, getDb } from './db.js';
import * as store from './store.js';
import { createAssistant, cleanCustomerText } from './ai.js';
import { alertTeam } from './notify.js';
import { signToken, verifyToken, makeLimiter, checkStaffLogin, parseCookies } from './security.js';
import { executeAction } from './shopify.js';
import { validSignature, parseWebhook, sendWhatsApp, whatsappEnabled, WINDOW_MS } from './whatsapp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const knowledgeDir = path.join(here, '..', 'knowledge');

export function createApp({ assistant, sendWa = sendWhatsApp, waEnabled = whatsappEnabled, runAction = executeAction, notify = alertTeam } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const ai = assistant || createAssistant();

  // ---------- cabeçalhos de segurança ----------
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/admin') || req.path.startsWith('/api/admin')) {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
    }
    next();
  });

  app.use(express.json({
    limit: '64kb',
    verify: (req, _res, buf) => { req.rawBody = buf; }, // necessário para validar a assinatura da Meta
  }));

  // ---------- CORS só para o chat do site ----------
  app.use('/api/chat', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      if (!config.allowedOrigins.includes(origin)) return res.status(403).json({ error: 'origin_not_allowed' });
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // ---------- chat do site ----------
  const ipLimit = makeLimiter(30, 10 * 60 * 1000);       // 30 msgs / 10 min por IP
  const startLimit = makeLimiter(10, 60 * 60 * 1000);    // 10 conversas novas / hora por IP
  const convLimit = makeLimiter(20, 10 * 60 * 1000);     // 20 msgs / 10 min por conversa
  const ratingLimit = makeLimiter(5, 60 * 60 * 1000);

  const publicMessages = (cid, after) =>
    store.getMessages(cid, after).filter((m) => m.role !== 'system')
      .map((m) => ({ id: m.id, role: m.role === 'customer' ? 'customer' : 'agent', who: m.role, text: m.content, at: m.created_at }));

  function convFromToken(req) {
    const h = req.headers.authorization || '';
    const p = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : '');
    if (!p || p.t !== 'web') return null;
    return store.getConversation(p.c);
  }

  app.post('/api/chat/message', async (req, res) => {
    if (!ipLimit(req.ip)) return res.status(429).json({ error: 'too_many_requests' });
    const text = cleanCustomerText(req.body?.text);
    if (!text) return res.status(400).json({ error: 'empty' });

    let conv = convFromToken(req);
    let token;
    if (!conv) {
      if (!startLimit(req.ip)) return res.status(429).json({ error: 'too_many_requests' });
      conv = store.findOrCreateConversation({ channel: 'web', externalId: 'w_' + Math.random().toString(36).slice(2) + Date.now().toString(36) });
      token = signToken({ t: 'web', c: conv.id }, 7 * 24 * 3600 * 1000);
    }
    if (!convLimit(conv.id)) return res.status(429).json({ error: 'too_many_requests' });
    const name = typeof req.body?.name === 'string' ? req.body.name.slice(0, 60) : null;
    if (name) store.setCustomer(conv.id, { name });

    const before = (store.getMessages(conv.id).slice(-1)[0] || { id: 0 }).id;
    const wasStatus = store.getConversation(conv.id).status;
    try {
      await ai.respond(conv, text);
    } catch (e) {
      console.error('Falha no chat:', e);
      return res.status(500).json({ error: 'server_error' });
    }
    const after = store.getConversation(conv.id);
    if (wasStatus === 'needs_human' || wasStatus === 'human')
      notify({ conversationId: conv.id, subject: 'Nova mensagem de cliente aguardando', text: `Cliente (site) escreveu: ${text.slice(0, 300)}` });
    res.json({ token, status: after.status, messages: publicMessages(conv.id, before) });
  });

  app.get('/api/chat/messages', (req, res) => {
    const conv = convFromToken(req);
    if (!conv) return res.status(401).json({ error: 'unauthorized' });
    res.json({ status: conv.status, messages: publicMessages(conv.id, Number(req.query.after) || 0) });
  });

  app.post('/api/chat/rating', (req, res) => {
    const conv = convFromToken(req);
    const stars = Number(req.body?.stars);
    if (!conv || !(stars >= 1 && stars <= 5) || !ratingLimit(conv.id)) return res.status(400).json({ error: 'invalid' });
    store.saveRating(conv.id, Math.round(stars));
    res.json({ ok: true });
  });

  // ---------- WhatsApp ----------
  app.get('/webhook/whatsapp', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': t, 'hub.challenge': ch } = req.query;
    if (mode === 'subscribe' && config.whatsapp.verifyToken && t === config.whatsapp.verifyToken) return res.status(200).send(String(ch));
    res.sendStatus(403);
  });

  const seen = new Set();
  const waLimit = makeLimiter(20, 10 * 60 * 1000);
  app.post('/webhook/whatsapp', (req, res) => {
    if (!validSignature(req.rawBody, req.headers['x-hub-signature-256'])) return res.sendStatus(401);
    res.sendStatus(200); // responde já; a Meta reenvia se demorar
    (async () => {
      for (const m of parseWebhook(req.body)) {
        if (seen.has(m.id)) continue;
        seen.add(m.id); if (seen.size > 5000) seen.delete(seen.values().next().value);
        try {
          const conv = store.findOrCreateConversation({ channel: 'whatsapp', externalId: m.from, name: m.name });
          if (m.type !== 'text' || !m.text) {
            store.addMessage(conv.id, 'customer', `[mensagem do tipo "${m.type}" — o assistente só lê texto]`);
            if (conv.status === 'ai')
              await sendWa(m.from, 'Thanks! I can only read text messages for now. Could you type your question?');
            else notify({ conversationId: conv.id, subject: 'Cliente enviou mídia no WhatsApp', text: `Tipo: ${m.type}` });
            continue;
          }
          if (!waLimit(m.from)) { logEvent('rate_limited', conv.id, 'whatsapp'); continue; }
          const status = conv.status;
          const reply = await ai.respond(conv, m.text);
          if (reply) await sendWa(m.from, reply);
          else if (status === 'needs_human' || status === 'human')
            notify({ conversationId: conv.id, subject: 'Nova mensagem no WhatsApp aguardando', text: `${m.name || m.from}: ${m.text.slice(0, 300)}` });
        } catch (e) { console.error('WhatsApp:', e.message); }
      }
    })();
  });

  // ---------- painel: autenticação ----------
  const loginLimit = makeLimiter(8, 10 * 60 * 1000);
  const secure = config.publicUrl.startsWith('https');

  app.post('/api/admin/login', (req, res) => {
    if (!loginLimit(req.ip)) return res.status(429).json({ error: 'too_many_attempts' });
    const email = checkStaffLogin(req.body?.email, req.body?.password);
    if (!email) { logEvent('login_failed', null, req.ip); return res.status(401).json({ error: 'invalid_credentials' }); }
    const tok = signToken({ t: 'staff', e: email }, 12 * 3600 * 1000);
    res.setHeader('Set-Cookie', `rc_staff=${encodeURIComponent(tok)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`);
    res.json({ email });
  });
  app.post('/api/admin/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'rc_staff=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  const admin = express.Router();
  admin.use((req, res, next) => {
    const p = verifyToken(parseCookies(req.headers.cookie).rc_staff);
    if (!p || p.t !== 'staff') return res.status(401).json({ error: 'unauthorized' });
    if (req.method !== 'GET' && req.get('X-Requested-With') !== 'rc-panel') return res.status(403).json({ error: 'csrf' });
    req.staff = p.e;
    next();
  });
  app.use('/api/admin', admin);

  admin.get('/me', (req, res) => res.json({ email: req.staff }));

  admin.get('/conversations', (req, res) => res.json(store.listConversations({ status: String(req.query.status || 'all') })));

  admin.get('/conversations/:id', (req, res) => {
    const c = store.getConversation(req.params.id);
    if (!c) return res.sendStatus(404);
    res.json({ conversation: c, messages: store.getMessages(c.id), actions: store.actionsForConversation(c.id) });
  });

  admin.post('/conversations/:id/take', (req, res) => {
    const c = store.getConversation(req.params.id);
    if (!c) return res.sendStatus(404);
    store.setStatus(c.id, 'human', { assignedTo: req.staff });
    store.addMessage(c.id, 'system', `${req.staff} assumiu o atendimento`);
    res.json({ ok: true });
  });

  admin.post('/conversations/:id/assign', (req, res) => {
    const c = store.getConversation(req.params.id);
    const to = String(req.body?.to || '').toLowerCase();
    if (!c || !config.staff.some((s) => s.email === to)) return res.sendStatus(400);
    store.setStatus(c.id, 'human', { assignedTo: to });
    store.addMessage(c.id, 'system', `${req.staff} passou a conversa para ${to}`);
    res.json({ ok: true });
  });

  admin.post('/conversations/:id/reply', async (req, res) => {
    const c = store.getConversation(req.params.id);
    const text = String(req.body?.text || '').trim().slice(0, 3000);
    if (!c || !text) return res.sendStatus(400);
    if (c.channel === 'whatsapp') {
      if (!waEnabled()) return res.status(400).json({ error: 'WhatsApp não configurado.' });
      if (Date.now() - (c.last_customer_at || 0) > WINDOW_MS)
        return res.status(400).json({ error: 'Janela de 24h do WhatsApp expirada: só dá para responder com um modelo aprovado pela Meta.' });
      try { await sendWa(c.external_id, text); }
      catch (e) { return res.status(502).json({ error: 'Falha ao enviar pelo WhatsApp: ' + e.message }); }
    }
    store.setStatus(c.id, 'human', { assignedTo: req.staff });
    store.addMessage(c.id, 'staff', text, req.staff);
    res.json({ ok: true });
  });

  admin.post('/conversations/:id/release', (req, res) => {
    const c = store.getConversation(req.params.id);
    if (!c) return res.sendStatus(404);
    store.setStatus(c.id, 'ai', {});
    store.addMessage(c.id, 'system', `${req.staff} devolveu a conversa para a IA`);
    res.json({ ok: true });
  });

  admin.post('/conversations/:id/resolve', (req, res) => {
    const c = store.getConversation(req.params.id);
    if (!c) return res.sendStatus(404);
    store.setStatus(c.id, 'resolved', {});
    store.addMessage(c.id, 'system', `${req.staff} marcou como resolvida`);
    res.json({ ok: true });
  });

  // ---- ações que exigem aprovação ----
  admin.get('/actions', (req, res) => res.json(store.listActions(req.query.status ? String(req.query.status) : undefined)));

  admin.post('/actions/:id/approve', async (req, res) => {
    const a = store.getAction(Number(req.params.id));
    if (!a) return res.sendStatus(404);
    if (a.status !== 'pending') return res.status(409).json({ error: 'Esta ação já foi decidida.' });
    // reserva a ação antes de executar: impede clique duplo / aprovação repetida
    if (!store.decideAction(a.id, 'approved', req.staff, 'executando...')) return res.status(409).json({ error: 'Esta ação já foi decidida.' });
    let result;
    try { result = await runAction(a); } catch (e) { result = { ok: false, message: 'Erro: ' + e.message }; }
    getDb().prepare('UPDATE actions SET status=?, result=? WHERE id=?').run(result.ok ? 'approved' : 'failed', String(result.message).slice(0, 1000), a.id);
    store.addMessage(a.conversation_id, 'system', `${req.staff} aprovou "${a.type}" (${a.order_name}): ${result.message}`);
    logEvent('action_' + (result.ok ? 'approved' : 'failed'), a.conversation_id, a.type);
    res.json(result);
  });

  admin.post('/actions/:id/reject', (req, res) => {
    const a = store.getAction(Number(req.params.id));
    if (!a) return res.sendStatus(404);
    if (!store.decideAction(a.id, 'rejected', req.staff, String(req.body?.note || '').slice(0, 300))) return res.status(409).json({ error: 'Esta ação já foi decidida.' });
    store.addMessage(a.conversation_id, 'system', `${req.staff} recusou "${a.type}" (${a.order_name})`);
    res.json({ ok: true });
  });

  admin.get('/report', (req, res) => res.json(store.reportSummary(Math.min(Number(req.query.days) || 30, 365))));

  // ---- conhecimento editável no painel ----
  const kPath = (rel) => {
    const full = path.resolve(knowledgeDir, String(rel || ''));
    if (!full.startsWith(knowledgeDir + path.sep) || !full.endsWith('.md')) return null;
    return full;
  };
  const listKnowledge = (d = knowledgeDir) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? listKnowledge(p) : e.name.endsWith('.md') && e.name !== 'LEIA-ME.md' ? [path.relative(knowledgeDir, p)] : [];
  }).sort();

  admin.get('/knowledge', (_req, res) => res.json({ files: listKnowledge(), report: ai.knowledgeReport() }));
  admin.get('/knowledge/file', (req, res) => {
    const p = kPath(req.query.file);
    if (!p || !fs.existsSync(p)) return res.sendStatus(404);
    res.json({ file: req.query.file, content: fs.readFileSync(p, 'utf8') });
  });
  admin.put('/knowledge/file', (req, res) => {
    const p = kPath(req.body?.file);
    const content = req.body?.content;
    if (!p || typeof content !== 'string' || content.length > 50000) return res.sendStatus(400);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    ai.refreshPrompt();
    logEvent('knowledge_edited', null, `${req.staff}: ${req.body.file}`);
    res.json({ ok: true, report: ai.knowledgeReport() });
  });

  // ---------- arquivos estáticos ----------
  app.use('/widget.js', (req, res, next) => { res.setHeader('Cache-Control', 'public, max-age=300'); next(); });
  app.use(express.static(path.join(here, '..', 'public'), { index: false }));
  app.get(['/admin', '/admin/'], (_req, res) => res.sendFile(path.join(here, '..', 'public', 'admin', 'index.html')));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  return app;
}

// ---------- inicialização ----------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const problems = validateConfig({ strict: true });
  const fatal = problems.filter((p) => !p.startsWith('ANTHROPIC'));
  problems.forEach((p) => console.warn('⚠️ ', p));
  if (fatal.length) { console.error('Configuração inválida. Corrija o .env e reinicie.'); process.exit(1); }
  openDb();
  const app = createApp();
  app.listen(config.port, () => console.log(`Atendimento Royal Caress em ${config.publicUrl} (porta ${config.port})`));
}
