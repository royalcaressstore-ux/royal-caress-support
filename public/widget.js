/* Chat Royal Caress — incluir com: <script src="https://SEU-DOMINIO/widget.js" defer></script> */
(function () {
  if (window.__rcChat) return;
  window.__rcChat = true;
  var script = document.currentScript || document.querySelector('script[src*="widget.js"]');
  var API = new URL(script.src).origin;
  var KEY = 'rc_chat_token';
  var token = null, lastId = 0, open = false, poll = null, sending = false, shown = {};
  try { token = localStorage.getItem(KEY); } catch (e) {}

  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483000;right:0;bottom:0;';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '\
<style>\
:host{all:initial}\
*{box-sizing:border-box;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}\
.btn{position:fixed;right:16px;bottom:16px;width:58px;height:58px;border-radius:50%;border:0;background:#8F0F31;color:#F5E1DA;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center}\
.btn:focus-visible,.send:focus-visible,.x:focus-visible{outline:3px solid #F5E1DA;outline-offset:2px}\
.btn svg{width:26px;height:26px}\
.panel{position:fixed;right:16px;bottom:88px;width:360px;max-width:calc(100vw - 24px);height:520px;max-height:calc(100vh - 110px);background:#FBF6F3;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden;border:1px solid #E3D3CC}\
.panel.on{display:flex}\
.hd{background:#0B0B0B;color:#F5E1DA;padding:14px 16px;display:flex;align-items:center;justify-content:space-between}\
.hd b{font-size:15px;letter-spacing:.04em}.hd small{display:block;font-size:11px;opacity:.75;margin-top:2px}\
.x{background:none;border:0;color:#F5E1DA;font-size:22px;cursor:pointer;line-height:1}\
.msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}\
.m{max-width:84%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}\
.m.customer{align-self:flex-end;background:#8F0F31;color:#fff;border-bottom-right-radius:4px}\
.m.agent{align-self:flex-start;background:#fff;color:#1B1B1B;border:1px solid #E3D3CC;border-bottom-left-radius:4px}\
.m.staff{border-color:#8F0F31}\
.note{font-size:11px;color:#6b5a54;text-align:center;padding:2px 8px}\
.typing{align-self:flex-start;color:#6b5a54;font-size:13px}\
.ft{border-top:1px solid #E3D3CC;padding:10px;background:#fff}\
.row{display:flex;gap:8px}\
textarea{flex:1;resize:none;border:1px solid #C9B3AA;border-radius:10px;padding:9px 10px;font-size:14px;height:42px;max-height:100px;background:#fff;color:#1B1B1B}\
textarea:focus{outline:2px solid #8F0F31;border-color:#8F0F31}\
.send{background:#8F0F31;color:#fff;border:0;border-radius:10px;padding:0 16px;font-weight:600;cursor:pointer}\
.send:disabled{opacity:.5;cursor:default}\
.human{background:none;border:0;color:#8F0F31;font-size:12px;text-decoration:underline;cursor:pointer;padding:6px 0 0}\
.rate{padding:8px 12px;font-size:12px;text-align:center;color:#6b5a54;border-top:1px solid #E3D3CC;background:#fff;display:none}\
.rate button{background:none;border:0;font-size:20px;cursor:pointer;color:#C9B3AA}.rate button.on{color:#8F0F31}\
</style>\
<button class="btn" aria-label="Open chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/></svg></button>\
<section class="panel" role="dialog" aria-label="Royal Caress chat">\
 <div class="hd"><div><b>Royal Caress</b><small>Virtual assistant · replies are discreet</small></div><button class="x" aria-label="Close chat">×</button></div>\
 <div class="msgs" aria-live="polite"></div>\
 <div class="rate" id="rate">How did we do? <span id="stars"></span></div>\
 <div class="ft">\
  <div class="row"><textarea rows="1" maxlength="1500" placeholder="Type your question…" aria-label="Your message"></textarea><button class="send">Send</button></div>\
  <button class="human">Talk to a person</button>\
 </div>\
</section>';
  document.body.appendChild(host);

  var $ = function (s) { return root.querySelector(s); };
  var btn = $('.btn'), panel = $('.panel'), msgs = $('.msgs'), ta = $('textarea'), send = $('.send');

  function add(role, text, cls) {
    var d = document.createElement('div');
    d.className = 'm ' + role + (cls ? ' ' + cls : '');
    d.textContent = text; // nunca innerHTML: texto do cliente/IA não executa código
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }
  function note(t) { var d = document.createElement('div'); d.className = 'note'; d.textContent = t; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; }
  function render(list) {
    list.forEach(function (m) {
      if (shown[m.id]) return; shown[m.id] = 1;
      lastId = Math.max(lastId, m.id);
      add(m.role, m.text, m.who === 'staff' ? 'staff' : '');
    });
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, opts.headers || {});
    return fetch(API + path, opts).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); });
  }

  function loadHistory() {
    if (!token) return;
    api('/api/chat/messages?after=0').then(function (r) {
      if (r.status === 401) { token = null; try { localStorage.removeItem(KEY); } catch (e) {} return; }
      if (r.ok) render(r.body.messages);
    }).catch(function () {});
  }
  function startPoll() {
    stopPoll();
    poll = setInterval(function () {
      if (!token || !open) return;
      api('/api/chat/messages?after=' + lastId).then(function (r) { if (r.ok) { render(r.body.messages); showRate(r.body.status); } }).catch(function () {});
    }, 4000);
  }
  function stopPoll() { if (poll) clearInterval(poll); poll = null; }

  function showRate(status) {
    if (status === 'resolved') $('#rate').style.display = 'block';
  }
  var starsEl = $('#stars');
  [1, 2, 3, 4, 5].forEach(function (n) {
    var b = document.createElement('button'); b.textContent = '★'; b.setAttribute('aria-label', n + ' stars');
    b.onclick = function () {
      api('/api/chat/rating', { method: 'POST', body: JSON.stringify({ stars: n }) }).then(function () {
        [].forEach.call(starsEl.children, function (c, i) { c.className = i < n ? 'on' : ''; });
        $('#rate').firstChild.textContent = 'Thank you! ';
      });
    };
    starsEl.appendChild(b);
  });

  function submit(text) {
    text = (text || '').trim();
    if (!text || sending) return;
    sending = true; send.disabled = true;
    add('customer', text);
    var typing = document.createElement('div'); typing.className = 'typing'; typing.textContent = 'Typing…'; msgs.appendChild(typing);
    msgs.scrollTop = msgs.scrollHeight;
    ta.value = '';
    api('/api/chat/message', { method: 'POST', body: JSON.stringify({ text: text }) }).then(function (r) {
      typing.remove();
      if (r.status === 429) { note('Too many messages — please wait a moment.'); return; }
      if (!r.ok) { note('Something went wrong. Please try again.'); return; }
      if (r.body.token) { token = r.body.token; try { localStorage.setItem(KEY, token); } catch (e) {} }
      // marca a mensagem do cliente (id do servidor) para não duplicar quando o polling trouxer o histórico
      r.body.messages.forEach(function (m) { if (m.role === 'customer') { shown[m.id] = 1; lastId = Math.max(lastId, m.id); } });
      render(r.body.messages);
      if (r.body.status === 'needs_human') note('Our team has been notified and will reply here.');
    }).catch(function () { typing.remove(); note('Connection problem. Please try again.'); })
      .then(function () { sending = false; send.disabled = false; ta.focus(); });
  }

  function toggle(v) {
    open = v === undefined ? !open : v;
    panel.classList.toggle('on', open);
    btn.style.display = open && window.innerWidth < 500 ? 'none' : 'flex';
    if (open) {
      if (!msgs.children.length) {
        add('agent', 'Hello, welcome to Royal Caress. I’m the virtual assistant — ask me about products, delivery, returns or your order. For anything sensitive I’ll bring in our team. This service is for adults (18+).');
        loadHistory();
      }
      startPoll(); ta.focus();
    } else stopPoll();
  }
  btn.onclick = function () { toggle(true); };
  $('.x').onclick = function () { toggle(false); };
  send.onclick = function () { submit(ta.value); };
  ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(ta.value); } });
  $('.human').onclick = function () { submit('I would like to speak with a person, please.'); };
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && open) toggle(false); });
  window.RoyalCaressChat = { open: function () { toggle(true); } };
})();
