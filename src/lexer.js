// Candor lexer. Newlines are statement terminators, except inside brackets
// or after a token that obviously continues the expression (operators, commas).

export const KEYWORDS = new Set([
  'fn', 'end', 'let', 'var', 'if', 'then', 'else', 'while', 'do', 'for', 'in',
  'return', 'break', 'continue', 'match', 'case', 'type', 'record', 'enum',
  'requires', 'ensures', 'example', 'effects', 'and', 'or', 'not', 'true', 'false', 'inout', 'use', 'distinct',
]);

const OPS3 = ['..<', '..='];
const OPS2 = ['->', '++', '==', '!=', '<=', '>='];
const OPS1 = '()[]{},:.+-*/%<>=?';
const CONTINUES = new Set([
  '+', '-', '*', '/', '%', '++', '==', '!=', '<', '<=', '>', '>=', '=', ',',
  '(', '[', '{', '.', '..<', '..=', '->', 'and', 'or', 'not',
]);

export class CandorError extends Error {
  constructor(diag) { super(diag.message); this.diag = diag; }
}

export function lex(src) {
  const toks = [];
  let i = 0, line = 1, col = 1, depth = 0;

  const fail = (message, hint) => {
    throw new CandorError({ severity: 'error', code: 'syntax', message, hint, line, col });
  };
  const adv = (n = 1) => { i += n; col += n; };
  const push = (kind, value, sl, sc, start) =>
    toks.push({ kind, value, line: sl, col: sc, start, end: i });

  while (i < src.length) {
    const c = src[i];
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '\n') {
      const prev = toks[toks.length - 1];
      const cont = prev && (prev.kind === 'op' || prev.kind === 'kw') && CONTINUES.has(prev.value);
      if (depth === 0 && prev && prev.kind !== 'nl' && !cont) push('nl', '\n', line, col, i);
      i++; line++; col = 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { adv(); continue; }

    const sl = line, sc = col, start = i;

    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9_]/.test(src[j])) j++;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true; j++;
        while (j < src.length && /[0-9_]/.test(src[j])) j++;
      }
      if ((src[j] === 'e' || src[j] === 'E') && /[0-9+-]/.test(src[j + 1] ?? '')) {
        isFloat = true; j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      const text = src.slice(i, j).replace(/_/g, '');
      adv(j - i);
      if (isFloat) push('float', Number(text), sl, sc, start);
      else {
        const v = Number(text);
        if (!Number.isSafeInteger(v)) fail(`integer literal ${text} is outside Int range (±9007199254740991)`);
        push('int', v, sl, sc, start);
      }
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      adv(j - i);
      push(KEYWORDS.has(word) ? 'kw' : 'ident', word, sl, sc, start);
      continue;
    }

    if (c === '"') {
      adv();
      let s = '';
      for (;;) {
        if (i >= src.length || src[i] === '\n') fail('unterminated string literal', 'strings must close on the same line');
        const d = src[i];
        if (d === '"') { adv(); break; }
        if (d === '\\') {
          const e = src[i + 1];
          const map = { n: '\n', t: '\t', '\\': '\\', '"': '"', '0': '\0' };
          if (!(e in map)) fail(`unknown escape \\${e}`, 'valid escapes: \\n \\t \\\\ \\" \\0');
          s += map[e]; adv(2); continue;
        }
        s += d; adv();
      }
      push('str', s, sl, sc, start);
      continue;
    }

    const three = src.slice(i, i + 3), two = src.slice(i, i + 2);
    let op = OPS3.includes(three) ? three : OPS2.includes(two) ? two : OPS1.includes(c) ? c : null;
    if (!op) {
      const hint = c === '!' ? 'use `not` for negation and `!=` for inequality'
        : c === '&' || c === '|' ? 'use `and` / `or`'
        : c === ';' ? 'statements end at a newline; no semicolons'
        : c === '`' ? 'this looks like a Markdown code fence; the file must contain only Candor code, so delete the ``` lines' : undefined;
      fail(`unexpected character '${c}'`, hint);
    }
    adv(op.length);
    if ('([{'.includes(op)) depth++;
    if (')]}'.includes(op)) depth = Math.max(0, depth - 1);
    push('op', op, sl, sc, start);
  }
  if (toks.length && toks[toks.length - 1].kind !== 'nl') push('nl', '\n', line, col, i);
  push('eof', null, line, col, i);
  return toks;
}
