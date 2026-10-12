import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'knowledge');
const MAX_CHARS = 60000;

function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.md') && e.name !== 'LEIA-ME.md' && !e.name.startsWith('_') ? [p] : [];
  }).sort();
}

/** Lê todos os .md da pasta knowledge/ (recursivo) e devolve um único texto + um relatório do que falta. */
export function loadKnowledge(customDir) {
  const base = customDir || dir;
  const files = fs.existsSync(base) ? walk(base) : [];
  let text = '';
  const missing = [];
  for (const f of files) {
    const rel = path.relative(base, f);
    const body = fs.readFileSync(f, 'utf8').trim();
    const n = (body.match(/\[PREENCHER/g) || []).length;
    if (n) missing.push({ file: rel, count: n });
    text += `\n\n=== ARQUIVO: ${rel} ===\n${body}`;
  }
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '\n[... conhecimento truncado ...]';
  return { text: text.trim(), missing, files: files.length };
}
