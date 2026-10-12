import { getDb, now, newId, logEvent } from './db.js';

const db = () => getDb();

export function findOrCreateConversation({ channel, externalId, name }) {
  let c = db().prepare('SELECT * FROM conversations WHERE channel=? AND external_id=?').get(channel, externalId);
  if (c) {
    // conversa resolvida e cliente voltou a escrever: reabre para a IA
    if (c.status === 'resolved') {
      db().prepare("UPDATE conversations SET status='ai', flag_reason=NULL, assigned_to=NULL, updated_at=? WHERE id=?").run(now(), c.id);
      c = getConversation(c.id);
    }
    return c;
  }
  const id = newId();
  const t = now();
  db().prepare(`INSERT INTO conversations (id, channel, external_id, customer_name, status, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?)`).run(id, channel, externalId, name || null, 'ai', t, t);
  return getConversation(id);
}

export const getConversation = (id) => db().prepare('SELECT * FROM conversations WHERE id=?').get(id);

export function addMessage(conversationId, role, content, author) {
  const t = now();
  const r = db().prepare('INSERT INTO messages (conversation_id, role, author, content, created_at) VALUES (?,?,?,?,?)')
    .run(conversationId, role, author || null, content, t);
  db().prepare('UPDATE conversations SET updated_at=?, last_customer_at=COALESCE(?, last_customer_at) WHERE id=?')
    .run(t, role === 'customer' ? t : null, conversationId);
  return { id: Number(r.lastInsertRowid), conversation_id: conversationId, role, author: author || null, content, created_at: t };
}

export const getMessages = (conversationId, afterId = 0) =>
  db().prepare('SELECT id, role, author, content, created_at FROM messages WHERE conversation_id=? AND id>? ORDER BY id').all(conversationId, afterId);

export function setStatus(conversationId, status, { reason, assignedTo } = {}) {
  db().prepare('UPDATE conversations SET status=?, flag_reason=COALESCE(?, flag_reason), assigned_to=COALESCE(?, assigned_to), updated_at=? WHERE id=?')
    .run(status, reason ?? null, assignedTo ?? null, now(), conversationId);
  if (status === 'resolved') db().prepare('UPDATE conversations SET flag_reason=NULL WHERE id=?').run(conversationId);
}

export function setCustomer(conversationId, { name, email }) {
  db().prepare('UPDATE conversations SET customer_name=COALESCE(?, customer_name), customer_email=COALESCE(?, customer_email) WHERE id=?')
    .run(name || null, email || null, conversationId);
}

export const setVerifiedOrder = (conversationId, orderName) =>
  db().prepare('UPDATE conversations SET verified_order=? WHERE id=?').run(orderName, conversationId);

export function listConversations({ status, limit = 100 } = {}) {
  const base = `SELECT c.*, (SELECT content FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
                (SELECT COUNT(*) FROM actions a WHERE a.conversation_id=c.id AND a.status='pending') AS pending_actions
                FROM conversations c`;
  if (status && status !== 'all')
    return db().prepare(base + ' WHERE c.status=? ORDER BY c.updated_at DESC LIMIT ?').all(status, limit);
  return db().prepare(base + ' ORDER BY (c.status=\'needs_human\') DESC, c.updated_at DESC LIMIT ?').all(limit);
}

// ----- ações com aprovação -----
export function createAction({ conversationId, type, orderName, payload, reason }) {
  const r = db().prepare(`INSERT INTO actions (conversation_id, type, order_name, payload, reason, created_at)
                          VALUES (?,?,?,?,?,?)`).run(conversationId, type, orderName, JSON.stringify(payload || {}), reason || null, now());
  return Number(r.lastInsertRowid);
}
export const getAction = (id) => db().prepare('SELECT * FROM actions WHERE id=?').get(id);
export const listActions = (status) =>
  status
    ? db().prepare('SELECT * FROM actions WHERE status=? ORDER BY id DESC LIMIT 200').all(status)
    : db().prepare('SELECT * FROM actions ORDER BY id DESC LIMIT 200').all();
export const actionsForConversation = (cid) => db().prepare('SELECT * FROM actions WHERE conversation_id=? ORDER BY id').all(cid);

// marca de forma atômica: só uma decisão por ação (evita aprovar duas vezes)
export function decideAction(id, status, by, result) {
  const r = db().prepare("UPDATE actions SET status=?, decided_by=?, decided_at=?, result=? WHERE id=? AND status='pending'")
    .run(status, by, now(), result ? String(result).slice(0, 1000) : null, id);
  return r.changes === 1;
}

// ----- avaliações e métricas -----
export function saveRating(conversationId, stars) {
  db().prepare('INSERT OR REPLACE INTO ratings (conversation_id, stars, created_at) VALUES (?,?,?)').run(conversationId, stars, now());
}

export function countEventsSince(kind, since) {
  return db().prepare('SELECT COUNT(*) AS n FROM events WHERE kind=? AND created_at>=?').get(kind, since).n;
}

export const countConversationEvents = (conversationId, kind) =>
  db().prepare('SELECT COUNT(*) AS n FROM events WHERE conversation_id=? AND kind=?').get(conversationId, kind).n;

export function startOfDay(ts = now()) {
  const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime();
}

export function reportSummary(days = 30) {
  const since = now() - days * 86400000;
  const q = (sql, ...a) => db().prepare(sql).get(...a);
  const total = q('SELECT COUNT(*) n FROM conversations WHERE created_at>=?', since).n;
  const byChannel = db().prepare('SELECT channel, COUNT(*) n FROM conversations WHERE created_at>=? GROUP BY channel').all(since);
  const escalated = q("SELECT COUNT(DISTINCT conversation_id) n FROM events WHERE kind='escalated' AND created_at>=?", since).n;
  const aiReplies = q("SELECT COUNT(*) n FROM events WHERE kind='ai_reply' AND created_at>=?", since).n;
  const blocked = q("SELECT COUNT(*) n FROM events WHERE kind='suspicious_message' AND created_at>=?", since).n;
  const rating = q('SELECT AVG(stars) avg, COUNT(*) n FROM ratings WHERE created_at>=?', since);
  const actions = db().prepare('SELECT status, COUNT(*) n FROM actions WHERE created_at>=? GROUP BY status').all(since);
  const perDay = db().prepare(`SELECT date(created_at/1000,'unixepoch') d, COUNT(*) n FROM conversations
                               WHERE created_at>=? GROUP BY d ORDER BY d`).all(since);
  // tempo da primeira resposta (qualquer resposta que não seja do cliente)
  const frt = db().prepare(`SELECT AVG(r.t - f.t) avg FROM
      (SELECT conversation_id, MIN(created_at) t FROM messages WHERE role='customer' GROUP BY conversation_id) f
      JOIN (SELECT conversation_id, MIN(created_at) t FROM messages WHERE role IN ('ai','staff') GROUP BY conversation_id) r
      ON r.conversation_id=f.conversation_id WHERE f.t>=? AND r.t>=f.t`).get(since);
  const resolvedByAi = total ? Math.max(0, total - escalated) : 0;
  // perguntas mais frequentes (primeira mensagem do cliente, truncada)
  const firsts = db().prepare(`SELECT substr(content,1,80) q, COUNT(*) n FROM messages
      WHERE role='customer' AND created_at>=? GROUP BY lower(substr(content,1,80)) ORDER BY n DESC LIMIT 10`).all(since);
  return {
    days, total, byChannel, escalated, aiReplies, blocked,
    resolvedByAiPct: total ? Math.round((resolvedByAi / total) * 100) : 0,
    rating: { avg: rating.avg ? Number(rating.avg.toFixed(2)) : null, count: rating.n },
    actions, perDay,
    firstResponseSeconds: frt.avg ? Math.round(frt.avg / 1000) : null,
    topQuestions: firsts,
  };
}

export { logEvent };
