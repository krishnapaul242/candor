#!/usr/bin/env node
// candor check|run|test|build <file.cnd>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { load } from './loader.js';
import { check } from './check.js';
import { genJS } from './jsgen.js';
import { genC } from './cgen.js';

const USAGE = `candor — a language designed by and for a language model

usage:
  candor check <file.cnd> [--json]      type/effect check; lists holes
  candor run   <file.cnd> [--native]    run now (JS JIT), or build+run natively
  candor test  <file.cnd> [--json]      run every 'example' clause
  candor build <file.cnd> [-o out] [--emit-c] [--allow-holes]
`;

// candor <cmd> [flags] <file.cnd> [program args...]
const all = process.argv.slice(2);
let fileIdx = -1;
for (let i = 1; i < all.length; i++) {
  if (all[i] === '-o') { i++; continue; }
  if (!all[i].startsWith('--')) { fileIdx = i; break; }
}
const passArgs = all[0] === 'run' && fileIdx >= 0;
const argv = passArgs ? all.slice(0, fileIdx + 1) : all;
const progArgs = passArgs ? all.slice(fileIdx + 1) : [];
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const outIdx = argv.indexOf('-o');
const cmd = all[0], file = fileIdx >= 0 ? all[fileIdx] : undefined;
const json = flags.has('--json');

if (!cmd || !file || !['check', 'run', 'test', 'build'].includes(cmd)) {
  process.stdout.write(USAGE);
  process.exit(cmd ? 2 : 0);
}

if (!fs.existsSync(file)) { process.stderr.write(`cannot read ${file}\n`); process.exit(2); }

const fileLines = new Map();
const pathOf = (id) => mod.files[id ?? 0].path;
const linesOf = (id) => {
  if (!fileLines.has(id)) fileLines.set(id, mod.files[id ?? 0].src.split('\n'));
  return fileLines.get(id);
};

function render(d) {
  const sev = d.severity === 'error' ? '\x1b[31merror\x1b[0m' : '\x1b[33mnote\x1b[0m';
  let s = `${sev}[${d.code}] ${pathOf(d.file)}:${d.line}:${d.col}\n  ${d.message}\n`;
  const ln = linesOf(d.file ?? 0)[d.line - 1];
  if (ln !== undefined) {
    // Diagnostics often go straight back into a model's context: keep them short.
    let shown = ln, caret = d.col;
    if (ln.length > 160) {
      const start = Math.max(0, d.col - 61);
      const end = Math.min(ln.length, start + 120);
      shown = (start > 0 ? '...' : '') + ln.slice(start, end) + (end < ln.length ? '...' : '');
      caret = d.col - start + (start > 0 ? 3 : 0);
    }
    s += `   ${String(d.line).padStart(4)} | ${shown}\n          ${' '.repeat(Math.max(0, caret - 1))}^\n`;
  }
  if (d.hint) s += `  hint: ${d.hint}\n`;
  return s;
}
const renderHole = (h) =>
  `\x1b[36mhole\x1b[0m ?${h.name} : ${h.type}   (${pathOf(h.file)}:${h.line}:${h.col}, in ${h.fn})\n` +
  (h.scope.length ? `  in scope: ${h.scope.map((v) => `${v.name}: ${v.type}`).join(', ')}\n` : '');

// Load `file` and everything it uses; stop after parsing if any file failed to parse.
const mod = load(file);
function frontEnd() {
  if (mod.diags.length) return { program: null, info: null, diags: mod.diags, holes: [] };
  const info = check(mod.program, mod);
  info.files = mod.files;
  return { program: mod.program, info, diags: info.diags, holes: info.holes };
}

const { program, info, diags, holes } = frontEnd();
const errors = diags.filter((d) => d.severity === 'error');
if (!errors.length && (cmd === 'run' || cmd === 'build') && !info.fns.has('main')) {
  errors.push({ severity: 'error', code: 'no-main', file: 0, message: `no 'fn main()' to run`, line: 1, col: 1, hint: `add:\n\nfn main()\n  effects io\n  print("hello")\nend fn main` });
}

if (cmd === 'check' || errors.length) {
  if (json) {
    const withPath = (x) => ({ ...x, file: pathOf(x.file) });
    process.stdout.write(JSON.stringify({ ok: !errors.length, diagnostics: (errors.length ? errors : diags).map(withPath), holes: holes.map(withPath) }, null, 2) + '\n');
  } else {
    for (const d of (errors.length ? errors : diags)) process.stderr.write(render(d));
    for (const h of holes) process.stderr.write(renderHole(h));
    if (!errors.length) process.stderr.write(`ok: ${program.fns.length} fn(s), ${info.types.size} type(s), ${holes.length} hole(s)\n`);
  }
  process.exit(errors.length ? 1 : 0);
}

function loadJS(opts) {
  const code = genJS(program, info, opts);
  if (process.env.CANDOR_DUMP) fs.writeFileSync(process.env.CANDOR_DUMP, code);
  const io = {
    write: (s) => fs.writeSync(1, Buffer.from(s, 'latin1')),
    ewrite: (s) => fs.writeSync(2, Buffer.from(s, 'latin1')),
    exists: (p) => { try { return fs.statSync(Buffer.from(p, 'latin1').toString('utf8')).isFile(); } catch { return false; } },
    read: (p) => { try { return fs.readFileSync(Buffer.from(p, 'latin1').toString('utf8')).toString('latin1'); } catch { return null; } },
    writeFile: (p, c) => { try { fs.writeFileSync(Buffer.from(p, 'latin1').toString('utf8'), Buffer.from(c, 'latin1')); return true; } catch { return false; } },
    exit: (c) => process.exit(c),
    args: progArgs.map((a) => Buffer.from(a, 'utf8').toString('latin1')),
  };
  return new Function('$io', code)(io);
}

function reportTrap(e, Trap) {
  if (e instanceof Trap) fs.writeSync(2, Buffer.from(e.message + '\n', 'latin1'));
  else if (e instanceof RangeError && /call stack/.test(e.message)) process.stderr.write('trap: stack overflow\n');
  else throw e;
}

function buildNative(outPath) {
  if (holes.length && !flags.has('--allow-holes')) {
    for (const h of holes) process.stderr.write(renderHole(h));
    process.stderr.write(`refusing to build: ${holes.length} unfilled hole(s). Fill them, or pass --allow-holes (they trap if reached).\n`);
    process.exit(1);
  }
  const c = genC(program, info);
  const cPath = flags.has('--emit-c') ? outPath + '.c' : path.join(os.tmpdir(), `candor-${process.pid}.c`);
  fs.writeFileSync(cPath, c);
  try {
    execFileSync('cc', ['-std=gnu11', '-O2', '-ffp-contract=off', '-w', cPath, '-o', outPath, '-lm'], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch {
    process.stderr.write(`internal error: generated C failed to compile (${cPath}). This is a Candor bug.\n`);
    process.exit(3);
  } finally {
    if (!flags.has('--emit-c') && !process.env.CANDOR_KEEP_C) fs.rmSync(cPath, { force: true });
  }
}

if (cmd === 'run' && !flags.has('--native')) {
  const rt = loadJS({});
  try { rt.main(); } catch (e) { reportTrap(e, rt.Trap); process.exit(1); }
} else if (cmd === 'run') {
  const exe = path.join(os.tmpdir(), `candor-${process.pid}`);
  buildNative(exe);
  const r = spawnSync(exe, progArgs, { stdio: 'inherit' });
  fs.rmSync(exe, { force: true });
  process.exit(r.status ?? 1);
} else if (cmd === 'build') {
  const out = outIdx >= 0 ? argv[outIdx + 1] : path.basename(file).replace(/\.cnd$/, '');
  buildNative(out);
  process.stderr.write(`built ${out}\n`);
} else if (cmd === 'test') {
  const rt = loadJS({ examples: true });
  try { rt.init(); } catch (e) { reportTrap(e, rt.Trap); process.exit(1); }
  const results = [];
  for (const ex of rt.examples) {
    let r;
    try { r = ex.run(); }
    catch (e) {
      if (!(e instanceof rt.Trap) && !(e instanceof RangeError)) throw e;
      r = { ok: false, trap: e.message };
    }
    results.push({ fn: ex.fn, line: ex.line, src: ex.src, ...r });
  }
  rt.flush();
  const failed = results.filter((r) => !r.ok);
  if (json) process.stdout.write(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2) + '\n');
  else {
    for (const r of results) {
      const mark = r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      let line = `${mark} ${r.fn}: ${r.src}`;
      if (!r.ok && r.trap) line += `\n    ${r.trap}`;
      else if (!r.ok && r.l !== undefined) line += `\n    left:  ${r.l}\n    right: ${r.r}`;
      process.stdout.write(line + '\n');
    }
    process.stdout.write(`${results.length - failed.length} passed, ${failed.length} failed\n`);
  }
  process.exit(failed.length ? 1 : 0);
}
