// Module loader: follows `use "path"` from the main file, parses each file once,
// stamps every AST node with its file id, and merges the declarations.
import fs from 'node:fs';
import { parse } from './parser.js';
import { CandorError } from './lexer.js';

export function normPath(p) {
  const abs = p.startsWith('/');
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else if (seg === '..' && abs) continue;
    else parts.push(seg);
  }
  return (abs ? '/' : '') + parts.join('/');
}
export const dirname = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
export const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
export const joinPath = (dir, p) => normPath(p.startsWith('/') || dir === '' ? p : `${dir}/${p}`);

// Path of `to` as written from a file in directory `fromDir` (both normalized).
export function relPath(fromDir, to) {
  const a = fromDir === '' ? [] : fromDir.split('/');
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

function stamp(node, file) {
  if (Array.isArray(node)) { for (const x of node) stamp(x, file); return; }
  if (!node || typeof node !== 'object') return;
  if ('line' in node && node.file === undefined) node.file = file;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object' && k !== 'binding' && k !== 'fn' && k !== 'variant') stamp(v, file);
  }
}

// Returns { files: [{path, src}], uses: [[fileId]], program, diags }.
// File ids are assigned in discovery order (main = 0); declarations are merged
// dependencies-first so constants can only see constants from earlier files.
export function load(mainPath) {
  const files = [], uses = [], parsed = [], order = [], diags = [];
  const index = new Map();
  function visit(path, from) {
    path = normPath(path);
    if (index.has(path)) return index.get(path);
    if (from && !fs.existsSync(path)) {
      diags.push({ severity: 'error', code: 'use-missing', file: from.file, line: from.line, col: from.col,
        message: `cannot find module '${from.path}' (looked for ${path})`, hint: 'paths in use are relative to the file that contains the use' });
      return -1;
    }
    const id = files.length;
    index.set(path, id);
    const src = fs.readFileSync(path, 'utf8');
    files.push({ path, src });
    uses.push([]);
    let program;
    try { program = parse(src); }
    catch (e) {
      if (!(e instanceof CandorError)) throw e;
      diags.push({ ...e.diag, file: id });
      program = { types: [], fns: [], consts: [], uses: [] };
    }
    stamp(program, id);
    parsed[id] = program;
    for (const u of program.uses) {
      const dep = visit(joinPath(dirname(path), u.path), u);
      if (dep >= 0 && !uses[id].includes(dep)) uses[id].push(dep);
    }
    order.push(id);
    return id;
  }
  visit(mainPath, null);
  const program = { types: [], fns: [], consts: [], uses: [] };
  for (const id of order) {
    program.types.push(...parsed[id].types);
    program.fns.push(...parsed[id].fns);
    program.consts.push(...parsed[id].consts);
  }
  return { files, uses, program, diags };
}
