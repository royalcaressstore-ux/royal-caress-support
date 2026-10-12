import { openDb } from '../src/db.js';

// Cliente Anthropic falso: cada chamada consome o próximo "roteiro" (função que recebe os parâmetros).
export function fakeClient(script) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        const step = script.shift();
        if (!step) throw new Error('roteiro esgotado');
        return typeof step === 'function' ? step(params) : step;
      },
    },
  };
}
export const text = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
export const tool = (name, input, id = 'tu_' + Math.random().toString(36).slice(2)) =>
  ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });

export function freshDb() { return openDb(':memory:'); }
