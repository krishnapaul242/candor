#!/usr/bin/env node
// Benchmark runner: times every bench/*.cnd on both backends (best of N),
// checks that JS and native print byte-identical output, and reports native peak memory.
//
//   node bench/run.js                 # all benchmarks, best of 3
//   node bench/run.js fib sort -n 5   # just these, best of 5
//   node bench/run.js --markdown      # README-ready table

import { spawnSync, execFileSync } from 'node:child_process';
import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.js');

const argv = process.argv.slice(2);
const nIdx = argv.indexOf('-n');
const reps = nIdx >= 0 ? Number(argv[nIdx + 1]) : 3;
const markdown = argv.includes('--markdown');
const only = argv.filter((a, i) => !a.startsWith('-') && argv[i - 1] !== '-n');

const all = readdirSync(here).filter((f) => f.endsWith('.cnd')).map((f) => f.slice(0, -4)).sort();
const names = only.length ? only : all;
for (const n of names) if (!all.includes(n)) { console.error(`no such benchmark: ${n} (have: ${all.join(', ')})`); process.exit(1); }

const tmp = mkdtempSync(path.join(tmpdir(), 'candor-bench-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

// Peak RSS via /usr/bin/time when available (macOS: -l, bytes; Linux: -v, KB).
const timeFlag = platform() === 'darwin' ? '-l' : platform() === 'linux' ? '-v' : null;
function peakRss(exe) {
  if (!timeFlag) return null;
  const r = spawnSync('/usr/bin/time', [timeFlag, exe], { encoding: 'utf8' });
  if (r.error) return null;
  const mac = r.stderr.match(/(\d+)\s+maximum resident set size/);
  if (mac) return Number(mac[1]);
  const lin = r.stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
  return lin ? Number(lin[1]) * 1024 : null;
}

function best(cmd, args) {
  let min = Infinity, out = null;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
    const dt = (performance.now() - t0) / 1000;
    if (r.status !== 0) return { error: `exit ${r.status}: ${(r.stderr || '').trim().split('\n').pop()}` };
    min = Math.min(min, dt);
    out = r.stdout;
  }
  return { time: min, out };
}

const fmtT = (r) => (r.error ? 'FAIL' : `${r.time.toFixed(2)}s`);
const fmtM = (b) => (b == null ? '-' : b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${Math.round(b / (1 << 20))} MB`);

const rows = [];
let failed = false;
for (const name of names) {
  const src = path.join(here, `${name}.cnd`);
  const exe = path.join(tmp, name);
  const b0 = performance.now();
  try {
    execFileSync('node', [cli, 'build', src, '-o', exe], { stdio: 'pipe' });
  } catch {
    rows.push({ name, js: { error: 'build failed' }, c: { error: 'build failed' }, build: NaN, mem: null, same: false });
    failed = true; continue;
  }
  const build = (performance.now() - b0) / 1000;
  const js = best('node', [cli, 'run', src]);
  const c = best(exe, []);
  const same = !js.error && !c.error && js.out === c.out;
  if (!same) failed = true;
  const row = { name, js, c, build, mem: c.error ? null : peakRss(exe), same };
  rows.push(row);
  if (!markdown) {
    const ratio = !js.error && !c.error ? `${(js.time / c.time).toFixed(1)}x` : '-';
    console.log(`${name.padEnd(8)}  js ${fmtT(js).padStart(6)}   native ${fmtT(c).padStart(6)}  (${ratio.padStart(5)})   build ${build.toFixed(2)}s   mem ${fmtM(row.mem).padStart(7)}   ${same ? 'outputs match' : 'OUTPUTS DIFFER'}`);
    if (js.error) console.log(`          js: ${js.error}`);
    if (c.error) console.log(`          native: ${c.error}`);
  }
}

if (markdown) {
  console.log(`| program | \`run\` (JS) | \`build\` (native) | native peak RSS |`);
  console.log(`|---|---|---|---|`);
  for (const r of rows) console.log(`| ${r.name} | ${fmtT(r.js)} | ${fmtT(r.c)} | ${fmtM(r.mem)} |`);
}
if (failed) { console.error('some benchmarks failed or disagreed between backends'); process.exit(1); }
