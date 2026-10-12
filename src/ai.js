import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { buildSystemPrompt, TOOLS, CANARY } from './prompt.js';
import { loadKnowledge } from './knowledge.js';
import * as store from './store.js';
import { logEvent } from './db.js';
import { lookupOrder as shopifyLookup, normalizeOrderNumber } from './shopify.js';
import { alertTeam } from './notify.js';

const MAX_CUSTOMER_CHARS = 1500;
const MAX_TOOL_ROUNDS = 4;
const HISTORY_LIMIT = 24;
const MAX_LOOKUP_FAILS = 4;

export const FALLBACK_HANDOFF = 'Thank you for your message. I’ve passed this to our team and someone will reply here as soon as possible.';
const SAFE_REPLACEMENT = 'Sorry, I can’t help with that here. Is there anything about our products, delivery or orders I can help you with?';

// Padrões comuns de tentativa de manipulação (só para registrar/alertar; a defesa real é o prompt + ferramentas limitadas).
const SUSPICIOUS = [
  /ignore (all |any |your |the )?(previous|prior|above|earlier) (instructions|rules|prompt)/i,
  /(reveal|show|print|repeat|tell me) (me )?(your|the) (system )?(prompt|instructions|rules)/i,
  /developer mode|jailbreak|\bDAN\b|do anything now/i,
  /you are now|act as (the )?(owner|admin|manager|shopify|developer)/i,
  /i('| a)m (the )?(owner|admin|developer|manager|from shopify|from anthropic)/i,
  /(discount|coupon|promo) code.*(give|generate|create|make)|(give|generate|create|make).*(discount|coupon|promo) code/i,
  /esque[cç]a (as |todas as )?(regras|instru[cç][oõ]es)|ignore (as )?(instru[cç][oõ]es|regras)/i,
  /system prompt|prompt do sistema/i,
];

export function looksSuspicious(text) {
  return SUSPICIOUS.some((r) => r.test(text));
}

export function cleanCustomerText(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/<\/?customer_message>/gi, '')
    .trim()
    .slice(0, MAX_CUSTOMER_CHARS);
}

const LEAK = [/sk-ant-[A-Za-z0-9_-]{10,}/, /shp(at|ca|pa)_[A-Za-z0-9]{10,}/, /EAA[A-Za-z0-9]{40,}/];
export function outputIsSafe(text) {
  if (text.includes(CANARY) || text.includes('RC-CANARY')) return false;
  if (LEAK.some((r) => r.test(text))) return false;
  if (/(<customer_message>|HARD RULES|KNOWLEDGE section|escalate_to_human|request_order_action|lookup_order)/i.test(text)) return false;
  return true;
}

function toModelMessages(rows) {
  const out = [];
  for (const m of rows.slice(-HISTORY_LIMIT)) {
    if (m.role === 'system') continue;
    const role = m.role === 'customer' ? 'user' : 'assistant';
    const content = role === 'user' ? `<customer_message>\n${cleanCustomerText(m.content)}\n</customer_message>` : m.content;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n' + content;
    else out.push({ role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

export function createAssistant({ client, lookupOrder = shopifyLookup, notify = alertTeam, knowledgeDir } = {}) {
  const anthropic = client || (config.anthropicKey ? new Anthropic({ apiKey: config.anthropicKey }) : null);
  let knowledge = loadKnowledge(knowledgeDir);
  const reload = () => (knowledge = loadKnowledge(knowledgeDir));
  let systemText = buildSystemPrompt(knowledge.text);

  function escalate(conv, reason, summary) {
    store.setStatus(conv.id, 'needs_human', { reason: `${reason}: ${summary || ''}`.slice(0, 300) });
    store.addMessage(conv.id, 'system', `Passou para a equipe — ${reason}${summary ? ': ' + summary : ''}`);
    logEvent('escalated', conv.id, reason);
    notify({
      conversationId: conv.id,
      subject: `Cliente precisa de você (${reason})`,
      text: `Conversa ${conv.channel}${conv.customer_name ? ' com ' + conv.customer_name : ''}.\nMotivo: ${reason}\nResumo: ${summary || '-'}`,
    });
  }

  async function runTool(conv, name, input) {
    if (name === 'escalate_to_human') {
      escalate(conv, String(input.reason || 'other'), String(input.summary || '').slice(0, 300));
      return 'Conversation handed to the human team.';
    }

    if (name === 'lookup_order') {
      const fails = store.countConversationEvents(conv.id, 'lookup_failed');
      if (fails >= MAX_LOOKUP_FAILS) {
        escalate(conv, 'suspicious', 'Muitas tentativas de consulta de pedido sem sucesso.');
        return 'Lookup is locked for this conversation. Tell the customer the team will help them.';
      }
      const num = normalizeOrderNumber(input.order_number);
      let res = { ok: false };
      try {
        if (num && input.email) res = await lookupOrder({ orderNumber: num, email: String(input.email) });
      } catch (e) {
        console.error('lookupOrder:', e.message);
        return 'The order system is temporarily unavailable. Offer to pass the request to the team (escalate_to_human).';
      }
      if (!res.ok) {
        logEvent('lookup_failed', conv.id, num || 'invalid');
        return 'No order matched these details. Ask the customer to re-check the order number and the email used at checkout. Do not say which one was wrong.';
      }
      store.setVerifiedOrder(conv.id, `#${num}`);
      store.setCustomer(conv.id, { email: String(input.email).toLowerCase() });
      const { id, ...safe } = res.order; // nunca expõe o id interno
      return JSON.stringify(safe);
    }

    if (name === 'request_order_action') {
      const num = normalizeOrderNumber(input.order_number);
      const fresh = store.getConversation(conv.id);
      if (!num || fresh.verified_order !== `#${num}`)
        return 'Refused: the order must first be verified with lookup_order in this conversation (number + email). Ask the customer for them.';
      const type = input.type;
      if (!['cancel_order', 'refund_order', 'update_address'].includes(type)) return 'Unknown action type.';
      const payload = {};
      if (type === 'update_address') {
        const a = input.new_address || {};
        if (!a.address1 || !a.city || !a.postcode) return 'Missing address fields: need address1, city and postcode. Ask the customer.';
        payload.new_address = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, String(v).slice(0, 200)]));
      }
      const id = store.createAction({ conversationId: conv.id, type, orderName: `#${num}`, payload, reason: String(input.reason || '').slice(0, 300) });
      escalate(conv, 'order_action', `${type} do pedido #${num} aguardando aprovação (ação ${id})`);
      return 'Request registered for human review. Tell the customer the team will review it and reply here. Do not promise the outcome.';
    }
    return 'Unknown tool.';
  }

  /**
   * Processa uma mensagem do cliente e devolve o texto a enviar (ou null se a IA deve ficar em silêncio).
   */
  async function respond(conv, customerText) {
    const text = cleanCustomerText(customerText);
    if (!text) return null;
    store.addMessage(conv.id, 'customer', text);

    if (looksSuspicious(text)) logEvent('suspicious_message', conv.id, text.slice(0, 120));
    if (store.countConversationEvents(conv.id, 'suspicious_message') >= 3 && conv.status === 'ai') {
      escalate(conv, 'suspicious', 'Várias tentativas de manipular o assistente.');
      const msg = FALLBACK_HANDOFF;
      store.addMessage(conv.id, 'ai', msg);
      return msg;
    }

    const current = store.getConversation(conv.id);
    if (current.status !== 'ai') return null; // equipe cuida; IA em silêncio

    if (!anthropic) {
      escalate(conv, 'other', 'IA não configurada (falta ANTHROPIC_API_KEY).');
      store.addMessage(conv.id, 'ai', FALLBACK_HANDOFF);
      return FALLBACK_HANDOFF;
    }

    if (store.countEventsSince('ai_reply', store.startOfDay()) >= config.maxAiRepliesPerDay) {
      logEvent('rate_limited', conv.id, 'limite diário de respostas da IA');
      escalate(conv, 'other', 'Limite diário de respostas da IA atingido.');
      store.addMessage(conv.id, 'ai', FALLBACK_HANDOFF);
      return FALLBACK_HANDOFF;
    }

    const messages = toModelMessages(store.getMessages(conv.id));
    let reply = '';
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const resp = await anthropic.messages.create({
          model: config.model,
          max_tokens: 700,
          system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
          tools: TOOLS,
          messages,
        });
        const toolUses = resp.content.filter((b) => b.type === 'tool_use');
        reply = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (resp.stop_reason !== 'tool_use' || !toolUses.length || round === MAX_TOOL_ROUNDS) break;
        messages.push({ role: 'assistant', content: resp.content });
        const results = [];
        for (const tu of toolUses) {
          const out = await runTool(store.getConversation(conv.id), tu.name, tu.input || {});
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out) });
        }
        messages.push({ role: 'user', content: results });
      }
    } catch (e) {
      console.error('Erro na IA:', e.message);
      logEvent('ai_error', conv.id, e.message);
      escalate(store.getConversation(conv.id), 'other', 'Erro técnico na IA.');
      store.addMessage(conv.id, 'ai', FALLBACK_HANDOFF);
      return FALLBACK_HANDOFF;
    }

    if (!reply) reply = store.getConversation(conv.id).status === 'needs_human' ? FALLBACK_HANDOFF : SAFE_REPLACEMENT;
    if (!outputIsSafe(reply)) {
      logEvent('blocked_output', conv.id, 'resposta bloqueada pelo filtro de saída');
      escalate(store.getConversation(conv.id), 'suspicious', 'Resposta da IA bloqueada pelo filtro (possível vazamento).');
      reply = SAFE_REPLACEMENT;
    }
    reply = reply.slice(0, 1500);
    store.addMessage(conv.id, 'ai', reply);
    logEvent('ai_reply', conv.id);
    return reply;
  }

  return { respond, reload, knowledgeReport: () => ({ files: knowledge.files, missing: knowledge.missing }),
           refreshPrompt: () => { reload(); systemText = buildSystemPrompt(knowledge.text); } };
}
