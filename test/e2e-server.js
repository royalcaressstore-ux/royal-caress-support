// Servidor de demonstração com IA SIMULADA (não gasta API). Usado nos testes de navegador.
import fs from 'node:fs';
import { openDb } from '../src/db.js';
import { config } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createAssistant } from '../src/ai.js';

const port = Number(process.env.PORT || 4010);
config.sessionSecret = 'e'.repeat(40);
config.staff = [{ email: 'ana@loja.com', password: 'senha-forte-123' }];
config.allowedOrigins = [`http://127.0.0.1:${port}`];
config.publicUrl = `http://127.0.0.1:${port}`;
openDb(':memory:');

const client = { messages: { create: async (p) => {
  const last = p.messages.at(-1);
  if (Array.isArray(last.content)) return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'I have passed this to our team; they will reply here.' }] };
  const m = String(last.content).toLowerCase();
  if (/person|human|broken|damaged/.test(m)) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'escalate_to_human', input: { reason: 'damaged_or_wrong_item', summary: 'Cliente relata item danificado' } }] };
  if (/rose/.test(m)) return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The Skins Rose Lix costs £35.99.' }] };
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Happy to help! Ask me about our products, delivery or returns.' }] };
} } };
const app = createApp({ assistant: createAssistant({ client, notify: () => {} }) });
app.get('/demo', (_q, r) => r.type('html').send('<!doctype html><title>Demo</title><body style="font-family:sans-serif"><h1>Loja de teste</h1><script src="/widget.js" defer></script>'));
app.listen(port, () => console.log('e2e on', port));
