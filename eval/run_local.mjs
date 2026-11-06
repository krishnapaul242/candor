#!/usr/bin/env node
// Drive a local model (Ollama) through the Candor evaluation, with a repair loop.
//
//   node eval/run_local.mjs qwen2.5-coder:7b [--rounds 3] [--tasks fizzbuzz,csv]
//
// For each task: the system prompt is docs/llms.txt, the user prompt is the task from
// eval/TASKS.md. The reply's code block becomes attempt round 0. While `candor check`
// reports errors (up to --rounds times), the model gets ONLY the compiler's diagnostics
// back and is asked for a corrected file. Every round is saved and logged, so we can see
// which diagnostics models act on correctly and which they misread.
//
// Output: eval/attempts/<model>/<task>.cnd (final), <task>.r<N>.cnd (each round),
//         eval/results/<model>.json (per-task log). Then run eval/score.sh on the folder.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const model = argv[0];
if (!model) { console.error('usage: node eval/run_local.mjs <ollama-model> [--rounds N] [--tasks a,b]'); process.exit(2); }
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const maxRounds = Number(opt('--rounds', 3));
const host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

const spec = fs.readFileSync(path.join(root, 'docs/llms.txt'), 'utf8');
const tasksMd = fs.readFileSync(path.join(root, 'eval/TASKS.md'), 'utf8');
const [preamble, ...sections] = tasksMd.split(/\n---\n/);
const taskBlocks = sections.join('\n---\n').split(/\n(?=## \d+\. )/).map((s) => s.trim()).filter((s) => s.startsWith('## '));
const tasks = taskBlocks.map((b) => ({ name: b.match(/^## \d+\. (\w+)/)[1], text: b }));
const only = opt('--tasks', null)?.split(',');
const selected = only ? tasks.filter((t) => only.includes(t.name)) : tasks;

const slug = model.replace(/[^A-Za-z0-9._-]/g, '_');
const outDir = path.join(root, 'eval/attempts', slug);
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(root, 'eval/results'), { recursive: true });

const SYSTEM = `You write code in Candor, a programming language you have not seen before. The complete language reference follows. Use only what it describes.\n\n${spec}`;
const RULES = `Rules:
- Write ONE Candor file for this task: exactly the types and functions it specifies, plus any helpers you need.
- Prefix every helper function's name with the task name, e.g. topword_split.
- Do NOT write a main function. A hidden test program will call your functions.
- Reply with the complete file inside a single fenced code block, and nothing else.`;

async function chat(messages) {
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, options: { temperature: 0, num_ctx: 16384, seed: 1, num_predict: 2048 } }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return { text: j.message.content, evalTokens: j.eval_count ?? 0, seconds: (j.total_duration ?? 0) / 1e9 };
}

function extractCode(text) {
  const blocks = [...text.matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length) return blocks.sort((a, b) => b.length - a.length)[0];
  const open = text.match(/```[a-zA-Z]*\n([\s\S]*)$/); // reply cut off before the closing fence
  if (open) return open[1];
  return text; // no fence: take the whole reply
}

function check(file) {
  try {
    execFileSync('node', [path.join(root, 'src/cli.js'), 'check', file], { stdio: 'pipe' });
    return { ok: true, text: '', codes: [] };
  } catch (e) {
    const text = String(e.stderr).replace(/\x1b\[[0-9;]*m/g, '');
    const codes = [...text.matchAll(/^error\[([a-z-]+)\]/gm)].map((m) => m[1]);
    return { ok: false, text, codes };
  }
}

function examples(file) {
  try {
    execFileSync('node', [path.join(root, 'src/cli.js'), 'test', file], { stdio: 'pipe' });
    return { ok: true, text: '', failed: 0 };
  } catch (e) {
    const text = String(e.stdout).replace(/\x1b\[[0-9;]*m/g, '');
    return { ok: false, text, failed: Number(text.match(/(\d+) failed/)?.[1] ?? 1) };
  }
}

const log = { model, maxRounds, date: new Date().toISOString(), tasks: {} };
for (const t of selected) {
  const file = path.join(outDir, `${t.name}.cnd`);
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${preamble.replace(/^# .*\n/, '').trim()}\n\n${t.text}\n\n${RULES}` },
  ];
  const rounds = [];
  for (let r = 0; r <= maxRounds; r++) {
    let reply;
    try { reply = await chat(messages); }
    catch (e) {
      // A model that never stops (common for tiny models) counts as a failed task, not a crashed run.
      rounds.push({ round: r, ok: false, codes: ['no-reply'], error: String(e.cause?.code ?? e.message) });
      process.stdout.write(`${t.name} round ${r}: no reply (${e.cause?.code ?? e.message})\n`);
      break;
    }
    const code = extractCode(reply.text);
    fs.writeFileSync(path.join(outDir, `${t.name}.r${r}.cnd`), code);
    fs.writeFileSync(file, code);
    const c = check(file);
    // Once it compiles, run the model's OWN `example` clauses (no hidden tests are revealed).
    const ex = c.ok ? examples(file) : { ok: true, text: '', failed: 0 };
    const ok = c.ok && ex.ok;
    const codes = c.ok ? (ex.ok ? [] : ['example-failed']) : c.codes;
    rounds.push({ round: r, ok, compiles: c.ok, codes, tokens: reply.evalTokens, seconds: Math.round(reply.seconds) });
    process.stdout.write(`${t.name} round ${r}: ${!c.ok ? `${c.codes.length} error(s) [${[...new Set(c.codes)].join(', ')}]` : ex.ok ? 'compiles, own examples pass' : `compiles, ${ex.failed} own example(s) fail`}\n`);
    if (ok || r === maxRounds) break;
    // Repair: the model sees only what the compiler (or its own examples) said.
    const shown = file.replace(root + '/', '');
    messages.push({ role: 'assistant', content: reply.text });
    messages.push({ role: 'user', content: !c.ok
      ? `The Candor compiler rejected your file (${shown}):\n\n${c.text.trim()}\n\nFix every error. Reply with the complete corrected file in a single fenced code block, and nothing else.`
      : `Your file compiles, but some of your own \`example\` clauses fail (candor test ${shown}):\n\n${ex.text.trim()}\n\nFix the code (or the example, if the example itself is wrong according to the task). Reply with the complete corrected file in a single fenced code block, and nothing else.` });
  }
  log.tasks[t.name] = { rounds, compiledAtRound: rounds.findIndex((x) => x.compiles ?? x.ok), doneAtRound: rounds.findIndex((x) => x.ok) };
}
fs.writeFileSync(path.join(root, 'eval/results', `${slug}.json`), JSON.stringify(log, null, 2) + '\n');
console.log(`\nwrote ${path.relative(root, outDir)}/ and eval/results/${slug}.json`);
console.log(`score with: eval/score.sh ${path.relative(root, outDir)}`);
