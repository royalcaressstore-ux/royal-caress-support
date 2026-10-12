// Painel da equipe. Todo texto vindo de clientes/IA entra por textContent (nunca innerHTML).
const app = document.getElementById('app');
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'rc-panel' };
const state = { tab: 'conversas', filter: 'all', selected: null, me: null, timer: null, kfile: null };

async function api(path, method = 'GET', body) {
  const r = await fetch('/api/admin' + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  if (r.status === 401 && path !== '/login') { showLogin(); throw new Error('unauthorized'); }
  if (!r.ok) throw new Error((j && j.error) || 'Erro ' + r.status);
  return j;
}

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
function toast(msg) { const t = el('div', { class: 'toast' }, msg); document.body.append(t); setTimeout(() => t.remove(), 3500); }
const fmt = (ts) => new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const STATUS = { ai: 'IA atendendo', needs_human: 'Precisa de você', human: 'Com a equipe', resolved: 'Resolvida' };
const ACTION = { cancel_order: 'Cancelar pedido', refund_order: 'Reembolsar pedido', update_address: 'Alterar endereço' };

// ---------- login ----------
function showLogin(msg) {
  clearInterval(state.timer);
  const email = el('input', { type: 'email', autocomplete: 'username', required: true });
  const pass = el('input', { type: 'password', autocomplete: 'current-password', required: true });
  const err = el('div', { class: 'err' }, msg || '');
  const form = el('form', { class: 'login card', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try { await api('/login', 'POST', { email: email.value, password: pass.value }); boot(); }
    catch (x) { err.textContent = x.message === 'too_many_attempts' ? 'Muitas tentativas. Aguarde alguns minutos.' : 'E-mail ou senha incorretos.'; }
  } },
    el('h1', {}, 'Atendimento · Royal Caress'),
    el('label', {}, 'E-mail'), email, el('label', {}, 'Senha'), pass,
    el('div', { style: 'margin-top:14px' }, el('button', { class: 'btn', type: 'submit' }, 'Entrar')), err);
  app.replaceChildren(form);
}

// ---------- estrutura ----------
async function boot() {
  try { state.me = (await api('/me')).email; } catch { return showLogin(); }
  render();
  clearInterval(state.timer);
  state.timer = setInterval(refreshLive, 8000);
}

function render() {
  const top = el('div', { class: 'top' }, el('b', {}, 'ROYAL CARESS'),
    ...[['conversas', 'Conversas'], ['aprovacoes', 'Aprovações'], ['relatorios', 'Relatórios'], ['conhecimento', 'Conhecimento']]
      .map(([k, l]) => el('button', { class: 'tab' + (state.tab === k ? ' on' : ''), 'data-tab': k, onclick: () => { state.tab = k; render(); } }, l, el('span', { class: 'badge', id: 'b-' + k, hidden: true }))),
    el('span', { class: 'sp' }), el('span', { class: 'who' }, state.me),
    el('button', { class: 'tab', onclick: async () => { await api('/logout', 'POST'); showLogin(); } }, 'Sair'));
  const main = el('div', { class: 'wrap', id: 'main' });
  app.replaceChildren(top, main);
  ({ conversas: viewConversations, aprovacoes: viewActions, relatorios: viewReport, conhecimento: viewKnowledge })[state.tab](main);
  updateBadges();
}

async function updateBadges() {
  try {
    const [convs, acts] = await Promise.all([api('/conversations?status=needs_human'), api('/actions?status=pending')]);
    const set = (id, n) => { const b = document.getElementById(id); if (b) { b.hidden = !n; b.textContent = n; } };
    set('b-conversas', convs.length); set('b-aprovacoes', acts.length);
    document.title = (convs.length + acts.length ? `(${convs.length + acts.length}) ` : '') + 'Atendimento · Royal Caress';
  } catch {}
}
function refreshLive() {
  updateBadges();
  if (state.tab === 'conversas') { loadList(); if (state.selected && !document.activeElement?.matches('.reply textarea')) loadDetail(state.selected, true); }
  if (state.tab === 'aprovacoes') viewActions(document.getElementById('main'));
}

// ---------- conversas ----------
function viewConversations(main) {
  const filters = el('div', { class: 'filters' }, ...[['all', 'Todas'], ['needs_human', 'Precisa de você'], ['human', 'Com a equipe'], ['ai', 'IA'], ['resolved', 'Resolvidas']]
    .map(([k, l]) => el('button', { class: 'chip' + (state.filter === k ? ' on' : ''), onclick: () => { state.filter = k; render(); } }, l)));
  main.append(el('div', { class: 'grid' },
    el('div', {}, filters, el('div', { class: 'card list', id: 'list' })),
    el('div', { class: 'card detail', id: 'detail' }, el('div', { class: 'empty' }, 'Selecione uma conversa'))));
  loadList();
  if (state.selected) loadDetail(state.selected);
}
async function loadList() {
  const box = document.getElementById('list'); if (!box) return;
  const rows = await api('/conversations?status=' + state.filter);
  if (!rows.length) return box.replaceChildren(el('div', { class: 'empty' }, 'Nenhuma conversa aqui.'));
  box.replaceChildren(...rows.map((c) => el('button', { class: 'item' + (c.id === state.selected ? ' on' : ''), onclick: () => { state.selected = c.id; loadList(); loadDetail(c.id); } },
    el('div', { class: 't' }, el('span', {}, `${c.channel === 'whatsapp' ? '🟢 WhatsApp' : '🌐 Site'} · ${c.customer_name || c.customer_email || (c.channel === 'whatsapp' ? '+' + c.external_id : 'Visitante')}`),
      el('span', { class: 'st ' + c.status }, STATUS[c.status])),
    el('div', { class: 'p' }, (c.pending_actions ? '⚠️ aprovação pendente · ' : '') + (c.last_message || '')),
    el('div', { class: 'p' }, fmt(c.updated_at)))));
}
async function loadDetail(id, keepScroll) {
  const box = document.getElementById('detail'); if (!box) return;
  let d; try { d = await api('/conversations/' + id); } catch { return; }
  const c = d.conversation;
  const prev = box.querySelector('.msgs'); const atBottom = !prev || prev.scrollHeight - prev.scrollTop - prev.clientHeight < 80;
  const draft = box.querySelector('.reply textarea')?.value || '';
  const run = async (path, ok) => { try { await api(path, 'POST'); if (ok) toast(ok); } catch (e) { toast(e.message); } loadList(); loadDetail(id); updateBadges(); };

  const head = el('div', { class: 'dhead' },
    el('h2', {}, `${c.customer_name || (c.channel === 'whatsapp' ? '+' + c.external_id : 'Visitante do site')}`, c.customer_email ? ` · ${c.customer_email}` : '', c.verified_order ? ` · pedido ${c.verified_order} verificado` : ''),
    el('span', { class: 'st ' + c.status }, STATUS[c.status] + (c.assigned_to ? ' · ' + c.assigned_to : '')),
    c.status !== 'human' && c.status !== 'resolved' ? el('button', { class: 'btn', onclick: () => run(`/conversations/${id}/take`, 'Você assumiu') }, 'Assumir') : null,
    c.status === 'human' || c.status === 'needs_human' ? el('button', { class: 'btn ghost', onclick: () => run(`/conversations/${id}/release`, 'Devolvida à IA') }, 'Devolver à IA') : null,
    c.status !== 'resolved' ? el('button', { class: 'btn ghost', onclick: () => run(`/conversations/${id}/resolve`, 'Resolvida') }, 'Resolver') : null);
  const notes = [];
  if (c.flag_reason && c.status === 'needs_human') notes.push(el('div', { class: 'acts' }, '🚩 ', c.flag_reason));
  for (const a of d.actions.filter((x) => x.status === 'pending')) notes.push(actionRow(a, () => { loadDetail(id); loadList(); updateBadges(); }));

  const msgs = el('div', { class: 'msgs' }, ...d.messages.map((m) => el('div', { class: 'm ' + m.role },
    m.role !== 'system' ? el('small', {}, `${{ customer: 'Cliente', ai: 'IA', staff: m.author || 'Equipe' }[m.role]} · ${fmt(m.created_at)}`) : null, m.content)));
  const ta = el('textarea', { placeholder: c.channel === 'whatsapp' ? 'Responder pelo WhatsApp…' : 'Responder no chat do site…' }); ta.value = draft;
  const sendBtn = el('button', { class: 'btn', onclick: async () => {
    if (!ta.value.trim()) return; sendBtn.disabled = true;
    try { await api(`/conversations/${id}/reply`, 'POST', { text: ta.value }); ta.value = ''; loadDetail(id); loadList(); } catch (e) { toast(e.message); }
    sendBtn.disabled = false;
  } }, 'Enviar');
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendBtn.click(); });
  box.replaceChildren(head, ...notes, msgs, el('div', { class: 'reply' }, ta, sendBtn));
  const m2 = box.querySelector('.msgs'); if (atBottom || !keepScroll) m2.scrollTop = m2.scrollHeight; else if (prev) m2.scrollTop = prev.scrollTop;
}

function actionRow(a, done) {
  const p = JSON.parse(a.payload || '{}');
  const addr = p.new_address ? Object.values(p.new_address).filter(Boolean).join(', ') : null;
  const decide = async (kind) => {
    const text = kind === 'approve' ? `Confirmar: ${ACTION[a.type]} do pedido ${a.order_name}? Isso será executado no Shopify.` : 'Recusar este pedido?';
    if (!confirm(text)) return;
    try { const r = await api(`/actions/${a.id}/${kind}`, 'POST', {}); toast(r.message || 'Feito'); } catch (e) { toast(e.message); }
    done();
  };
  return el('div', { class: 'acts' },
    el('div', {}, '⚠️ A IA pediu: ', el('b', {}, ACTION[a.type]), ' do pedido ', el('code', {}, a.order_name)),
    a.reason ? el('div', {}, 'Motivo do cliente: ', a.reason) : null, addr ? el('div', {}, 'Novo endereço: ', addr) : null,
    el('div', { class: 'act' },
      el('button', { class: 'btn ok', onclick: () => decide('approve') }, 'Aprovar e executar'),
      el('button', { class: 'btn bad', onclick: () => decide('reject') }, 'Recusar'),
      a.type === 'refund_order' ? el('small', {}, 'Reembolso nunca é automático: após aprovar, faça no Shopify.') : null));
}

// ---------- aprovações ----------
async function viewActions(main) {
  if (!main) return;
  const all = await api('/actions');
  const pend = all.filter((a) => a.status === 'pending'), done = all.filter((a) => a.status !== 'pending');
  main.replaceChildren(
    el('h2', {}, 'Aguardando você'),
    pend.length ? el('div', { class: 'card' }, pend.map((a) => el('div', {}, actionRow(a, () => viewActions(main)),
      el('div', { style: 'padding:0 14px 10px' }, el('button', { class: 'btn ghost', onclick: () => { state.tab = 'conversas'; state.selected = a.conversation_id; render(); } }, 'Abrir conversa'))))) : el('div', { class: 'card empty' }, 'Nada pendente 🎉'),
    el('h2', {}, 'Histórico'),
    el('div', { class: 'card' }, el('table', {}, el('tr', {}, ['Quando', 'Ação', 'Pedido', 'Decisão', 'Por', 'Resultado'].map((h) => el('th', {}, h))),
      done.map((a) => el('tr', {}, el('td', {}, fmt(a.decided_at || a.created_at)), el('td', {}, ACTION[a.type]), el('td', {}, a.order_name),
        el('td', {}, { approved: 'Aprovada', rejected: 'Recusada', failed: 'Falhou' }[a.status] || a.status), el('td', {}, a.decided_by || ''), el('td', {}, a.result || ''))))));
}

// ---------- relatórios ----------
async function viewReport(main) {
  const sel = el('select', { onchange: () => load(sel.value), style: 'width:auto' }, ...[7, 30, 90].map((d) => el('option', { value: d, selected: d === 30 }, `Últimos ${d} dias`)));
  const box = el('div');
  main.replaceChildren(el('div', { style: 'display:flex;gap:10px;align-items:center;margin-bottom:12px' }, el('h2', { style: 'margin:0' }, 'Relatórios'), sel), box);
  async function load(days) {
    const r = await api('/report?days=' + days);
    const k = (n, l) => el('div', { class: 'card kpi' }, el('div', { class: 'n' }, n), el('div', { class: 'l' }, l));
    const max = Math.max(1, ...r.perDay.map((d) => d.n));
    const frt = r.firstResponseSeconds == null ? '–' : r.firstResponseSeconds < 90 ? r.firstResponseSeconds + ' s' : Math.round(r.firstResponseSeconds / 60) + ' min';
    box.replaceChildren(
      el('div', { class: 'kpis' },
        k(r.total, 'Conversas'), k(r.resolvedByAiPct + '%', 'Resolvidas só pela IA'), k(r.escalated, 'Passaram para a equipe'),
        k(frt, 'Tempo médio da 1ª resposta'), k(r.rating.avg ? `${r.rating.avg} ★ (${r.rating.count})` : '–', 'Satisfação'), k(r.blocked, 'Tentativas de manipulação'), k(r.aiReplies, 'Respostas da IA')),
      el('div', { class: 'card', style: 'margin-bottom:14px' }, el('div', { style: 'padding:12px 14px 0;font-weight:600' }, 'Conversas por dia'),
        el('div', { class: 'bars' }, r.perDay.map((d) => el('i', { title: `${d.d}: ${d.n}`, style: `height:${Math.max(4, (d.n / max) * 100)}%` })))),
      el('div', { class: 'card', style: 'margin-bottom:14px' }, el('table', {}, el('tr', {}, el('th', {}, 'Canal'), el('th', {}, 'Conversas')),
        r.byChannel.map((c) => el('tr', {}, el('td', {}, c.channel === 'whatsapp' ? 'WhatsApp' : 'Site'), el('td', {}, c.n))))),
      el('div', { class: 'card' }, el('div', { style: 'padding:12px 14px 0;font-weight:600' }, 'Perguntas mais repetidas'),
        el('table', {}, r.topQuestions.map((q) => el('tr', {}, el('td', {}, q.q), el('td', {}, '×' + q.n))))),
      el('p', { class: 'who', style: 'color:var(--mut)' }, 'Aprovações: ' + (r.actions.map((a) => `${a.n} ${a.status}`).join(' · ') || 'nenhuma')));
  }
  load(30);
}

// ---------- conhecimento ----------
async function viewKnowledge(main) {
  const info = await api('/knowledge');
  const missing = Object.fromEntries(info.report.missing.map((m) => [m.file, m.count]));
  const total = info.report.missing.reduce((s, m) => s + m.count, 0);
  const editor = el('div', { class: 'card kedit', style: 'padding:12px' }, el('div', { class: 'empty' }, 'Escolha um arquivo'));
  const list = el('div', { class: 'card' }, info.files.map((f) => el('button', { class: 'kfile' + (state.kfile === f ? ' on' : ''), onclick: () => { state.kfile = f; open(f); [...list.children].forEach((x) => x.classList.toggle('on', x.dataset.f === f)); }, 'data-f': f },
    el('span', {}, f), missing[f] ? el('span', { class: 'need' }, missing[f] + ' a preencher') : null)));
  main.replaceChildren(el('h2', {}, 'Conhecimento do assistente'),
    el('p', { style: 'color:var(--mut);margin-top:-6px' }, total ? `Ainda há ${total} campos [PREENCHER] — nesses pontos a IA não responde e chama você.` : 'Tudo preenchido.'),
    el('div', { class: 'kgrid' }, list, editor));
  async function open(f) {
    const d = await api('/knowledge/file?file=' + encodeURIComponent(f));
    const ta = el('textarea', { spellcheck: 'false' }); ta.value = d.content;
    editor.replaceChildren(el('b', {}, f), el('div', { style: 'height:8px' }), ta, el('div', { style: 'margin-top:10px;display:flex;gap:8px;align-items:center' },
      el('button', { class: 'btn', onclick: async () => { try { await api('/knowledge/file', 'PUT', { file: f, content: ta.value }); toast('Salvo. A IA já usa a nova versão.'); viewKnowledge(main); } catch (e) { toast(e.message); } } }, 'Salvar'),
      el('small', { style: 'color:var(--mut)' }, 'Substitua cada [PREENCHER ...] pela informação real.')));
  }
  if (state.kfile && info.files.includes(state.kfile)) open(state.kfile);
}

boot();
