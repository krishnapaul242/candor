#!/usr/bin/env node
// Summarize repair-loop logs: node eval/compare.mjs eval/results/a.json [b.json ...]
// For each run: first-try compile rate, repairs that worked (and how many rounds),
// repairs that never converged, and the error codes seen most often.
import fs from 'node:fs';

for (const file of process.argv.slice(2)) {
  const log = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tasks = Object.entries(log.tasks);
  const compiles = (r) => r.compiles ?? r.ok;
  const first = tasks.filter(([, t]) => compiles(t.rounds[0] ?? {})).length;
  const exFixed = tasks.filter(([, t]) => t.rounds.some((r) => r.codes.includes('example-failed')) && t.doneAtRound >= 0);
  const repaired = tasks.filter(([, t]) => !compiles(t.rounds[0] ?? {}) && t.compiledAtRound > 0);
  const stuck = tasks.filter(([, t]) => t.compiledAtRound < 0);
  const codes = {};
  for (const [, t] of tasks) for (const r of t.rounds) for (const c of new Set(r.codes)) codes[c] = (codes[c] ?? 0) + 1;
  console.log(`\n${file}  (${log.model})`);
  console.log(`  compiled on first try: ${first}/${tasks.length}`);
  console.log(`  fixed by diagnostics:  ${repaired.length}  ${repaired.map(([n, t]) => `${n} (${t.compiledAtRound} round${t.compiledAtRound > 1 ? 's' : ''})`).join(', ')}`);
  if (exFixed.length) console.log(`  fixed via own examples: ${exFixed.length}  ${exFixed.map(([n, t]) => `${n} (${t.doneAtRound} round${t.doneAtRound > 1 ? 's' : ''})`).join(', ')}`);
  console.log(`  never compiled:        ${stuck.length}  ${stuck.map(([n, t]) => `${n} [${[...new Set(t.rounds.flatMap((r) => r.codes))].join(', ')}]`).join(', ')}`);
  console.log(`  error codes (rounds where seen): ${Object.entries(codes).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}×${n}`).join(', ') || 'none'}`);
}
