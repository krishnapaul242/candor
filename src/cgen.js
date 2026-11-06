// Candor -> C (compiled by clang -O2). Uses GNU statement expressions to pin
// evaluation order to left-to-right, matching the JS backend exactly.
import fs from 'node:fs';
import { mangle } from './check.js';
import { basename } from './loader.js';

const PRELUDE = fs.readFileSync(new URL('../runtime/candor_rt.h', import.meta.url), 'utf8');

const cStr = (s) => {
  const bytes = Buffer.from(s, 'utf8');
  let o = '"';
  for (const b of bytes) {
    if (b >= 32 && b < 127 && b !== 34 && b !== 92 && b !== 63) o += String.fromCharCode(b);
    else o += '\\' + b.toString(8).padStart(3, '0');
  }
  return [o + '"', bytes.length];
};

export function genC(program, info) {
  let tmp = 0;
  const T = () => `_t${tmp++}`;
  const copyDefs = new Map();
  const { types, variants } = info;

  const ctype = (t) => {
    switch (t.k) {
      case 'Dist': return ctype(types.get(t.name).baseT);
      case 'Int': return 'int64_t';
      case 'Float': return 'double';
      case 'Bool': return 'bool';
      case 'Str': return 'cn_str';
      case 'Unit': return 'void';
      case 'Arr': return 'cn_arr*';
      case 'Rec': return `R_${t.name}`;
      case 'Enum': return `E_${t.name}*`;
    }
    throw new Error('ctype ' + t.k);
  };
  const needsCopy = (t) => t.k === 'Arr' || (t.k === 'Rec' && types.get(t.name).fields.some((f) => needsCopy(f.t)));
  const copyFn = (t) => {
    const name = `cp_${mangle(t)}`;
    if (copyDefs.has(name)) return name;
    copyDefs.set(name, null);
    let body;
    const ct = ctype(t);
    if (t.k === 'Arr') {
      const et = ctype(t.el);
      const inner = needsCopy(t.el)
        ? `for (int64_t i = 0; i < a->len; i++) ((${et}*)b->data)[i] = ${copyFn(t.el)}(((${et}*)a->data)[i]);`
        : `memcpy(b->data, a->data, (size_t)a->len * sizeof(${et}));`;
      body = `static ${ct} ${name}(${ct} a) { cn_arr* b = cn_arr_new(a->len, sizeof(${et})); ${inner} return b; }`;
    } else {
      const td = types.get(t.name);
      const sets = td.fields.filter((f) => needsCopy(f.t)).map((f) => `r.f_${f.name} = ${copyFn(f.t)}(r.f_${f.name});`).join(' ');
      body = `static ${ct} ${name}(${ct} r) { ${sets} return r; }`;
    }
    copyDefs.set(name, [`static ${ct} ${name}(${ct});`, body]);
    return name;
  };

  // structural equality for arrays and records: eq_<mangle>(a, b)
  const eqFn = (t) => {
    const name = `eq_${mangle(t)}`;
    if (copyDefs.has(name)) return name;
    copyDefs.set(name, null);
    const ct = ctype(t);
    const sub = (u, a, b) => {
      const k = (u.k === 'Dist' ? types.get(u.name).baseT : u).k;
      if (u.k === 'Arr' || u.k === 'Rec') return `${eqFn(u)}(${a}, ${b})`;
      if (k === 'Str') return `cn_str_eq(${a}, ${b})`;
      return `(${a} == ${b})`;
    };
    let body;
    if (t.k === 'Arr') {
      const et = ctype(t.el);
      body = `static bool ${name}(${ct} a, ${ct} b) { if (a->len != b->len) return false; for (int64_t i = 0; i < a->len; i++) if (!${sub(t.el, `((${et}*)a->data)[i]`, `((${et}*)b->data)[i]`)}) return false; return true; }`;
    } else {
      const fs = types.get(t.name).fields.map((f) => sub(f.t, `a.f_${f.name}`, `b.f_${f.name}`));
      body = `static bool ${name}(${ct} a, ${ct} b) { return ${fs.join(' && ') || 'true'}; }`;
    }
    copyDefs.set(name, [`static bool ${name}(${ct}, ${ct});`, body]);
    return name;
  };

  // An expression is "simple" if evaluating it can't print, trap, or depend on order.
  const copies = (e) => (e.copy || e.copyIn) && needsCopy(e.ty);
  const simple = (e) => ['int', 'float', 'str', 'bool'].includes(e.e) || (e.e === 'ident' && !copies(e)) ||
    (e.e === 'field' && !copies(e) && simple(e.base));
  // Evaluate `parts` strictly left to right, then build the result from their values.
  const seq = (parts, build) => {
    if (parts.filter((p) => !simple(p.node)).length <= 1) return build(parts.map((p) => p.code));
    const decls = [], names = [];
    for (const p of parts) {
      if (simple(p.node)) { names.push(p.code); continue; }
      const n = T(); decls.push(`${ctype(p.node.ty)} ${n} = ${p.code};`); names.push(n);
    }
    return `({ ${decls.join(' ')} ${build(names)}; })`;
  };
  const L = (fn, e) => `${cStr(fn)[0]}, ${e.line}`;
  // trap label: "fn at file.cnd" (the runtime appends ":line")
  const label = (name, node) => `${name} at ${basename(info.files?.[node.file ?? 0]?.path ?? '?')}`;

  function expr(e, fn) {
    let s = exprInner(e, fn);
    if ((e.copy || e.copyIn) && needsCopy(e.ty)) s = `${copyFn(e.ty)}(${s})`;
    return s;
  }
  const parts = (nodes, fn) => nodes.map((n) => ({ node: n, code: expr(n, fn) }));

  function exprInner(e, fn) {
    switch (e.e) {
      case 'int': return `INT64_C(${e.v})`;
      case 'float': {
        if (Object.is(e.v, -0)) return '(-0.0)';
        if (!Number.isFinite(e.v)) return e.v > 0 ? 'INFINITY' : '(-INFINITY)';
        let s = e.v.toExponential(17 - 1); // exact round-trip
        return `(${s})`;
      }
      case 'str': { const [lit, n] = cStr(e.v); return `CN_S(${lit}, ${n})`; }
      case 'bool': return e.v ? 'true' : 'false';
      case 'hole': return `({ cn_trap(${L(fn, e)}, "reached hole ?${e.name}"); *(${ctype(e.ty)}*)0; })`;
      case 'ident': return e.variant ? `(&cn_V_${e.name})` : e.binding?.kind === 'inout' ? `(*p_${e.name})` : e.binding?.kind === 'const' ? `g_${e.name}` : `v_${e.name}`;
      case 'rec':
        return seq(parts(e.fields.map((f) => f.value), fn),
          (vals) => `((R_${e.name}){ ${e.fields.map((f, i) => `.f_${f.name} = ${vals[i]}`).join(', ')} })`);
      case 'arr': {
        const a = T(), et = ctype(e.ty.el);
        const sets = e.items.map((it, i) => `((${et}*)${a}->data)[${i}] = ${expr(it, fn)};`).join(' ');
        return `({ cn_arr* ${a} = cn_arr_new(${e.items.length}, sizeof(${et})); ${sets} ${a}; })`;
      }
      case 'index': {
        const et = ctype(e.ty);
        if (e.base.e === 'ident' && !e.base.binding?.kind?.match(/inout|const/) && simple(e.idx)) {
          return `((${et}*)v_${e.base.name}->data)[cn_at(v_${e.base.name}, ${expr(e.idx, fn)}, ${L(fn, e)})]`;
        }
        const a = T(), i = T();
        return `({ cn_arr* ${a} = ${expr(e.base, fn)}; int64_t ${i} = cn_at(${a}, ${expr(e.idx, fn)}, ${L(fn, e)}); ((${et}*)${a}->data)[${i}]; })`;
      }
      case 'field': return e.unwrap ? `(${expr(e.base, fn)})` : `(${expr(e.base, fn)}).f_${e.name}`;
      case 'un':
        if (e.op === 'not') return `(!${expr(e.x, fn)})`;
        return `(-${expr(e.x, fn)})`;
      case 'bin': {
        const { op } = e;
        if (op === 'and') return `(${expr(e.l, fn)} && ${expr(e.r, fn)})`;
        if (op === 'or') return `(${expr(e.l, fn)} || ${expr(e.r, fn)})`;
        const lt = (e.l.ty.k === 'Dist' ? types.get(e.l.ty.name).baseT : e.l.ty).k;
        const ps = parts([e.l, e.r], fn);
        if (op === '++') return seq(ps, ([l, r]) => `cn_cat(${l}, ${r})`);
        if (e.l.ty.k === 'Arr' || e.l.ty.k === 'Rec') return seq(ps, ([l, r]) => `${op === '!=' ? '!' : ''}${eqFn(e.l.ty)}(${l}, ${r})`);
        if (lt === 'Str') return seq(ps, ([l, r]) => `${op === '!=' ? '!' : ''}cn_str_eq(${l}, ${r})`);
        if (['==', '!=', '<', '<=', '>', '>='].includes(op) || lt === 'Float') return seq(ps, ([l, r]) => `(${l} ${op} ${r})`);
        const f = { '+': null, '-': null, '*': 'cn_mul', '/': 'cn_div', '%': 'cn_mod' }[op];
        if (f) return seq(ps, ([l, r]) => `${f}(${l}, ${r}, ${L(fn, e)})`);
        return seq(ps, ([l, r]) => `cn_ovf(${l} ${op} ${r}, ${L(fn, e)})`);
      }
      case 'call': {
        if (e.variant) {
          if (!e.variant.fields.length) return `(&cn_V_${e.name})`;
          return seq(parts(e.args, fn), (vals) => `mk_${e.name}(${vals.join(', ')})`);
        }
        if (e.wrap) return expr(e.args[0], fn);
        if (e.builtin) {
          const a0 = e.args[0];
          switch (e.name) {
            case 'print': return `cn_print(${expr(a0, fn)})`;
            case 'show':
              if (a0.ty.k === 'Dist') return ({ Int: 'cn_show_i', Float: 'cn_show_f', Bool: 'cn_show_b', Str: '' })[types.get(a0.ty.name).baseT.k] + `(${expr(a0, fn)})`;
              if (a0.ty.k === 'Enum') return `cn_names_${a0.ty.name}[(${expr(a0, fn)})->tag]`;
              return ({ Int: 'cn_show_i', Float: 'cn_show_f', Bool: 'cn_show_b', Str: '' })[a0.ty.k] + `(${expr(a0, fn)})`;
            case 'len': return `(${expr(a0, fn)})${a0.ty.k === 'Str' ? '.len' : '->len'}`;
            case 'push': {
              const et = ctype(e.args[1].ty);
              const a = T(), v = T();
              return `({ cn_arr* ${a} = ${placeValue(a0, fn)}; ${et} ${v} = ${expr(e.args[1], fn)}; *(${et}*)cn_arr_grow(${a}, sizeof(${et})) = ${v}; })`;
            }
            case 'pop': {
              const et = ctype(e.ty);
              const a = T();
              return `({ cn_arr* ${a} = ${placeValue(a0, fn)}; if (${a}->len == 0) cn_trap(${L(fn, e)}, "pop from empty array"); ((${et}*)${a}->data)[--${a}->len]; })`;
            }
            case 'array': {
              const et = ctype(e.ty.el);
              const n = T(), v = T(), a = T();
              const fill = needsCopy(e.ty.el) ? `${copyFn(e.ty.el)}(${v})` : v;
              return `({ int64_t ${n} = ${expr(a0, fn)}; ${et} ${v} = ${expr(e.args[1], fn)}; if (${n} < 0) cn_trap(${L(fn, e)}, "array: negative length %lld", (long long)${n}); cn_arr* ${a} = cn_arr_new(${n}, sizeof(${et})); for (int64_t i = 0; i < ${n}; i++) ((${et}*)${a}->data)[i] = ${fill}; ${a}; })`;
            }
            case 'to_float': return `((double)${expr(a0, fn)})`;
            case 'to_int': return `cn_to_int(${expr(a0, fn)}, ${L(fn, e)})`;
            case 'sqrt': return `sqrt(${expr(a0, fn)})`;
            case 'assert': {
              const [lit] = cStr('assertion failed: ' + a0.src);
              return `({ if (!(${expr(a0, fn)})) cn_trap(${L(fn, e)}, "%s", ${lit}); })`;
            }
            case 'clock_ms': return `cn_clock_ms()`;
          }
          const ps = parts(e.args, fn);
          switch (e.name) {
            case 'byte_at': return seq(ps, ([a, b]) => `cn_byte_at(${a}, ${b}, ${L(fn, e)})`);
            case 'slice': return seq(ps, ([a, b, c]) => `cn_slice(${a}, ${b}, ${c}, ${L(fn, e)})`);
            case 'from_byte': return `cn_from_byte(${ps[0].code}, ${L(fn, e)})`;
            case 'join': return seq(ps, ([a, b]) => `cn_join(${a}, ${b})`);
            case 'parse_float': return `cn_parse_float(${ps[0].code}, ${L(fn, e)})`;
            case 'eprint': return `cn_eprint(${ps[0].code})`;
            case 'args': return `cn_args()`;
            case 'exit': return `cn_exit(${ps[0].code})`;
            case 'read_file': return `cn_read_file(${ps[0].code}, ${L(fn, e)})`;
            case 'file_exists': return `cn_file_exists(${ps[0].code})`;
            case 'write_file': return seq(ps, ([a, b]) => `cn_write_file(${a}, ${b}, ${L(fn, e)})`);
          }
        }
        if (e.inout?.some(Boolean)) {
          const pre = [], argv = [];
          e.args.forEach((x, i) => {
            if (e.inout[i]) {
              const [pp, lv] = place(x, fn); const pt = T();
              pre.push(...pp, `${ctype(x.ty)}* ${pt} = &(${lv});`); argv.push(pt);
            } else { const t = T(); pre.push(`${ctype(x.ty)} ${t} = ${expr(x, fn)};`); argv.push(t); }
          });
          return `({ ${pre.join(' ')} f_${e.name}(${argv.join(', ')}); })`;
        }
        return seq(parts(e.args, fn), (vals) => `f_${e.name}(${vals.join(', ')})`);
      }
    }
    throw new Error('cgen: ' + e.e);
  }

  // Read a place without copying (used as push target).
  function placeValue(e, fn) {
    const [pre, lv] = place(e, fn);
    return pre.length ? `({ ${pre.join(' ')} ${lv}; })` : lv;
  }
  // place -> [preStatements, lvalue]
  function place(e, fn) {
    if (e.e === 'ident') return [[], e.binding?.kind === 'inout' ? `(*p_${e.name})` : `v_${e.name}`];
    if (e.e === 'field') { const [pre, lv] = place(e.base, fn); return [pre, `${lv}.f_${e.name}`]; }
    const [pre, lv] = place(e.base, fn);
    const a = T(), i = T(), et = ctype(e.ty);
    return [[...pre, `cn_arr* ${a} = ${lv};`, `int64_t ${i} = cn_at(${a}, ${expr(e.idx, fn)}, ${L(fn, e)});`], `((${et}*)${a}->data)[${i}]`];
  }

  function stmts(list, fn, ind) { return list.map((s) => stmt(s, fn, ind)).join(''); }
  function stmt(s, fn, ind) {
    const I = '  '.repeat(ind);
    switch (s.s) {
      case 'let':
        if (s.name === '_') return `${I}(void)(${expr(s.init, fn)});\n`;
        return `${I}${ctype(s.t)} v_${s.name} = ${expr(s.init, fn)};\n`;
      case 'assign': {
        const [pre, lv] = place(s.target, fn);
        const v = T();
        return `${I}{ ${pre.join(' ')} ${ctype(s.value.ty)} ${v} = ${expr(s.value, fn)}; ${lv} = ${v}; }\n`;
      }
      case 'expr': return `${I}${expr(s.expr, fn)};\n`;
      case 'if': {
        let o = '';
        s.arms.forEach((a, k) => {
          o += `${k ? ' else if' : `${I}if`} (${expr(a.cond, fn)}) {\n${stmts(a.body, fn, ind + 1)}${I}}`;
        });
        if (s.els) o += ` else {\n${stmts(s.els, fn, ind + 1)}${I}}`;
        return o + '\n';
      }
      case 'while': return `${I}while (${expr(s.cond, fn)}) {\n${stmts(s.body, fn, ind + 1)}${I}}\n`;
      case 'for': {
        if (s.range) {
          const end = T();
          return `${I}for (int64_t v_${s.name} = ${expr(s.range.start, fn)}, ${end} = ${expr(s.range.end, fn)}; v_${s.name} ${s.range.inclusive ? '<=' : '<'} ${end}; v_${s.name}++) {\n${stmts(s.body, fn, ind + 1)}${I}}\n`;
        }
        const a = T(), k = T(), et = ctype(s.t);
        return `${I}{ cn_arr* ${a} = ${expr(s.iter, fn)};\n${I}for (int64_t ${k} = 0; ${k} < ${a}->len; ${k}++) {\n${I}  ${et} v_${s.name} = ((${et}*)${a}->data)[${k}];\n${stmts(s.body, fn, ind + 1)}${I}} }\n`;
      }
      case 'match': {
        const m = T();
        let o = `${I}{ ${ctype(s.expr.ty)} ${m} = ${expr(s.expr, fn)};\n`;
        s.cases.forEach((c, k) => {
          const last = k === s.cases.length - 1;
          const cond = c.pat.wild || (last && s.exhaustive) ? null : `${m}->tag == ${c.variant?.index}`;
          const head = k === 0 ? (cond ? `${I}if (${cond}) ` : `${I}`) : (cond ? ` else if (${cond}) ` : ' else ');
          const binds = c.pat.wild ? '' : c.pat.binds.map((b, j) => b === '_' ? '' :
            `${I}  ${ctype(c.variant.fields[j].t)} v_${b} = ${m}->u.V_${c.variant.decl.name}.f_${c.variant.fields[j].name};\n`).join('');
          o += `${head}{\n${binds}${stmts(c.body, fn, ind + 1)}${I}}`;
        });
        return o + `\n${I}}\n`;
      }
      case 'return': return `${I}return${s.value ? ' ' + expr(s.value, fn) : ''};\n`;
      case 'break': return `${I}break;\n`;
      case 'continue': return `${I}continue;\n`;
    }
  }

  // ---- types ----
  const head = [PRELUDE];
  for (const td of types.values()) {
    head.push(td.kind === 'record' ? `typedef struct R_${td.name} R_${td.name};` : `typedef struct E_${td.name} E_${td.name};`);
  }
  const emitted = new Set();
  const emitRec = (td) => {
    if (emitted.has(td.name)) return;
    emitted.add(td.name);
    for (const f of td.fields) if (f.t.k === 'Rec') emitRec(types.get(f.t.name));
    head.push(`struct R_${td.name} { ${td.fields.map((f) => `${ctype(f.t)} f_${f.name};`).join(' ')} };`);
  };
  for (const td of types.values()) if (td.kind === 'record') emitRec(td);
  for (const td of types.values()) {
    if (td.kind !== 'enum') continue;
    const members = td.variants.filter((v) => v.fields.length)
      .map((v) => `struct { ${v.fields.map((f) => `${ctype(f.t)} f_${f.name};`).join(' ')} } V_${v.name};`);
    head.push(`struct E_${td.name} { int tag;${members.length ? ` union { ${members.join(' ')} } u;` : ''} };`);
    head.push(`static const cn_str cn_names_${td.name}[] = { ${td.variants.map((v) => `CN_S("${v.name}", ${v.name.length})`).join(', ')} };`);
    for (const v of td.variants) {
      if (!v.fields.length) { head.push(`static E_${td.name} cn_V_${v.name} = { ${td.variants.indexOf(v)} };`); continue; }
      const ps = v.fields.map((f, i) => `${ctype(f.t)} a${i}`).join(', ');
      const sets = v.fields.map((f, i) => `p->u.V_${v.name}.f_${f.name} = a${i};`).join(' ');
      head.push(`static E_${td.name}* mk_${v.name}(${ps}) { E_${td.name}* p = cn_alloc(sizeof *p); p->tag = ${td.variants.indexOf(v)}; ${sets} return p; }`);
    }
  }

  // ---- functions ----
  const protos = [], bodies = [];
  for (const f of program.fns) {
    const rt = ctype(f.sig.ret);
    const params = f.sig.params.map((p) => p.inout ? `${ctype(p.t)}* p_${p.name}` : `${ctype(p.t)} v_${p.name}`).join(', ') || 'void';
    const args = f.sig.params.map((p) => `${p.inout ? 'p' : 'v'}_${p.name}`).join(', ');
    const hasContracts = f.requires.length || f.ensures.length;
    const bodyName = hasContracts ? `f_${f.name}__body` : `f_${f.name}`;
    protos.push(`static ${rt} ${bodyName}(${params});`);
    const tail = f.sig.ret.k !== 'Unit' ? `  cn_trap(${cStr(label(f.name, f))[0]}, ${f.line}, "missing return");\n` : '';
    bodies.push(`static ${rt} ${bodyName}(${params}) {\n${stmts(f.body, label(f.name, f), 1)}${tail}}`);
    if (hasContracts) {
      protos.push(`static ${rt} f_${f.name}(${params});`);
      let w = `static ${rt} f_${f.name}(${params}) {\n`;
      for (const r of f.requires) w += `  if (!(${expr(r, label(f.name, f))})) cn_trap(${L(label(f.name, f), r)}, "%s", ${cStr('requires failed: ' + r.src)[0]});\n`;
      if (rt === 'void') w += `  ${bodyName}(${args});\n`;
      else w += `  ${rt} v_result = ${bodyName}(${args});\n`;
      for (const en of f.ensures) w += `  if (!(${expr(en, label(f.name, f))})) cn_trap(${L(label(f.name, f), en)}, "%s", ${cStr('ensures failed: ' + en.src)[0]});\n`;
      if (rt !== 'void') w += `  return v_result;\n`;
      bodies.push(w + '}');
    }
  }
  const consts = program.consts ?? [];
  const globals = consts.map((c) => `static ${ctype(c.t)} g_${c.name};`);
  const init = `static void cn_init(void) {\n${consts.map((c) => `  g_${c.name} = ${expr(c.init, label(c.name, c))};\n`).join('')}}`;
  const copyList = [...copyDefs.values()];
  return [
    ...head,
    ...copyList.map((c) => c[0]),
    ...protos,
    ...globals,
    ...copyList.map((c) => c[1]),
    ...bodies,
    init,
    `int main(int argc, char** argv) { cn_argc = argc; cn_argv = argv; cn_init(); f_main(); fflush(stdout); return 0; }`,
  ].join('\n') + '\n';
}
