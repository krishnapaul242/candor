// Candor -> JavaScript. Used by `candor run` and `candor test`: no build step,
// V8 JIT-compiles the result. Semantics must match the C backend exactly.
import { mangle } from './check.js';
import { basename } from './loader.js';

// Candor Str values are byte strings: each JS char holds one UTF-8 byte (0-255),
// so len/byte_at/slice agree with the C backend.
const bin = (s) => JSON.stringify(Buffer.from(s, 'utf8').toString('latin1'));

const PRELUDE = String.raw`
"use strict";
const $MAXI = 9007199254740991;
class $Trap extends Error {}
function $trap(msg, fn, line) { throw new $Trap("trap in " + fn + ":" + line + ": " + msg); }
function $ovf(r, fn, line) { if (r > $MAXI || r < -$MAXI) $trap("integer overflow", fn, line); return r; }
function $div(a, b, fn, line) {
  if (b === 0) $trap("division by zero", fn, line);
  if (Math.abs(a) < 2147483648 && Math.abs(b) < 2147483648) return Math.trunc(a / b);
  return Number(BigInt(a) / BigInt(b));
}
function $mod(a, b, fn, line) { if (b === 0) $trap("division by zero", fn, line); return a % b + 0; }
function $at(a, i, fn, line) {
  if (i < 0 || i >= a.length) $trap("index " + i + " out of bounds for length " + a.length, fn, line);
  return i;
}
function $to_int(x, fn, line) {
  if (!(x > -9007199254740992 && x < 9007199254740992)) $trap("to_int: " + $show_f(x) + " is outside Int range", fn, line);
  return Math.trunc(x) + 0;
}
function $array(n, v, cp, fn, line) {
  if (n < 0) $trap("array: negative length " + n, fn, line);
  if (!cp) return new Array(n).fill(v);
  const a = [];
  for (let i = 0; i < n; i++) a.push(cp(v));
  return a;
}
function $show_f(x) {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const neg = x < 0;
  const m = (neg ? -x : x).toExponential().split("e");
  let digits = m[0].replace(".", "");
  while (digits.length > 1 && digits.endsWith("0")) digits = digits.slice(0, -1);
  return (neg ? "-" : "") + $fmt_float(digits, Number(m[1]));
}
function $fmt_float(d, exp) {
  if (exp >= -7 && exp < 21) {
    if (exp >= 0) {
      const ip = d.slice(0, exp + 1).padEnd(exp + 1, "0");
      const fp = d.slice(exp + 1);
      return ip + "." + (fp || "0");
    }
    return "0." + "0".repeat(-exp - 1) + d;
  }
  return d[0] + (d.length > 1 ? "." + d.slice(1) : "") + "e" + (exp < 0 ? "-" : "+") + Math.abs(exp);
}
let $buf = [], $bufLen = 0;
function $print(s) {
  $buf.push(s, "\n"); $bufLen += s.length;
  if ($bufLen > 65536) $flush();
}
function $flush() { if ($buf.length) { $io.write($buf.join("")); $buf = []; $bufLen = 0; } }
function $byte_at(s, i, fn, line) {
  if (i < 0 || i >= s.length) $trap("byte_at: index " + i + " out of bounds for length " + s.length, fn, line);
  return s.charCodeAt(i);
}
function $slice(s, a, b, fn, line) {
  if (a < 0 || a > b || b > s.length) $trap("slice " + a + ".." + b + " out of bounds for length " + s.length, fn, line);
  return s.slice(a, b);
}
function $from_byte(b, fn, line) {
  if (b < 0 || b > 255) $trap("from_byte: " + b + " is not a byte", fn, line);
  return String.fromCharCode(b);
}
function $parse_float(s, fn, line) {
  if (!/^[+-]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][+-]?[0-9]+)?$/.test(s)) $trap("parse_float: invalid number \"" + s + "\"", fn, line);
  return Number(s);
}
function $read_file(p, fn, line) {
  const r = $io.read(p);
  if (r === null) $trap("cannot read file " + p, fn, line);
  return r;
}
function $write_file(p, c, fn, line) { if (!$io.writeFile(p, c)) $trap("cannot write file " + p, fn, line); }
function $exit(c) { $flush(); $io.exit(c); }
function $pop(a, fn, line) { if (a.length === 0) $trap("pop from empty array", fn, line); return a.pop(); }
`;

export function genJS(program, info, { examples = false } = {}) {
  // trap label: "fn at file.cnd" (the runtime appends ":line")
  const label = (name, node) => `${name} at ${basename(info.files?.[node.file ?? 0]?.path ?? '?')}`;
  const out = [PRELUDE];
  const copyFns = new Map();
  let tmp = 0;
  const T = () => `$t${tmp++}`;

  const needsCopy = (t) => t.k === 'Arr' || t.k === 'Rec';
  const base = (t) => (t.k === 'Dist' ? info.types.get(t.name).baseT : t);
  const copyFn = (t) => {
    const name = `$cp_${mangle(t)}`;
    if (copyFns.has(name)) return name;
    copyFns.set(name, null);
    let body;
    if (t.k === 'Arr') body = needsCopy(t.el) ? `(a) => a.map(${copyFn(t.el)})` : `(a) => a.slice()`;
    else {
      const td = info.types.get(t.name);
      body = `(r) => ({ ${td.fields.map((f) => `${f.name}: ${needsCopy(f.t) ? `${copyFn(f.t)}(r.${f.name})` : `r.${f.name}`}`).join(', ')} })`;
    }
    copyFns.set(name, `const ${name} = ${body};`);
    return name;
  };

  for (const td of info.types.values()) {
    if (td.kind === 'enum') out.push(`const $names_${td.name} = ${JSON.stringify(td.variants.map((v) => v.name))};`);
  }
  // enum singletons for payload-less variants
  for (const [vn, v] of info.variants) {
    if (!v.fields.length) out.push(`const $V_${vn} = Object.freeze({ $t: ${v.index} });`);
  }

  function expr(e, fn) {
    let s = exprInner(e, fn);
    if ((e.copy || e.copyIn) && needsCopy(e.ty)) s = `${copyFn(e.ty)}(${s})`;
    return s;
  }
  const L = (e, fn) => `${JSON.stringify(fn)}, ${e.line}`;

  function exprInner(e, fn) {
    switch (e.e) {
      case 'int': return String(e.v);
      case 'float': return Object.is(e.v, -0) ? '-0' : String(e.v);
      case 'str': return bin(e.v);
      case 'bool': return String(e.v);
      case 'hole': return `$trap(${bin(`reached hole ?${e.name}`)}, ${L(e, fn)})`;
      case 'ident':
        if (e.variant) return `$V_${e.name}`;
        return e.binding?.kind === 'inout' ? `p_${e.name}.v` : e.binding?.kind === 'const' ? `g_${e.name}` : `v_${e.name}`;
      case 'rec':
        return `{ ${e.fields.map((f) => `${f.name}: ${expr(f.value, fn)}`).join(', ')} }`;
      case 'arr': return `[${e.items.map((x) => expr(x, fn)).join(', ')}]`;
      case 'index': {
        if (e.base.e === 'ident' && e.base.binding?.kind !== 'inout' && e.base.binding?.kind !== 'const') return `v_${e.base.name}[$at(v_${e.base.name}, ${expr(e.idx, fn)}, ${L(e, fn)})]`;
        const a = T();
        return `((${a}) => ${a}[$at(${a}, ${expr(e.idx, fn)}, ${L(e, fn)})])(${expr(e.base, fn)})`;
      }
      case 'field': return e.unwrap ? `(${expr(e.base, fn)})` : `(${expr(e.base, fn)}).${e.name}`;
      case 'un':
        if (e.op === 'not') return `(!${expr(e.x, fn)})`;
        return e.ty.k === 'Int' ? `(0 - ${expr(e.x, fn)})` : `(-${expr(e.x, fn)})`;
      case 'bin': {
        const l = expr(e.l, fn), r = expr(e.r, fn);
        switch (e.op) {
          case 'and': return `(${l} && ${r})`;
          case 'or': return `(${l} || ${r})`;
          case '++': return `(${l} + ${r})`;
          case '==': return `(${l} === ${r})`;
          case '!=': return `(${l} !== ${r})`;
          case '<': case '<=': case '>': case '>=': return `(${l} ${e.op} ${r})`;
        }
        if (e.ty.k === 'Float') return `(${l} ${e.op} ${r})`;
        if (e.op === '/') return `$div(${l}, ${r}, ${L(e, fn)})`;
        if (e.op === '%') return `$mod(${l}, ${r}, ${L(e, fn)})`;
        return `$ovf(${l} ${e.op} ${r}, ${L(e, fn)})`;
      }
      case 'call': {
        if (e.variant) {
          if (!e.variant.fields.length) return `$V_${e.name}`;
          return `{ $t: ${e.variant.index}, ${e.variant.fields.map((f, i) => `${f.name}: ${expr(e.args[i], fn)}`).join(', ')} }`;
        }
        if (e.inout?.some(Boolean)) {
          const pre = [], argv = [], back = [];
          e.args.forEach((x, i) => {
            if (e.inout[i]) {
              const [pp, lv] = place(x, fn); const b = T();
              pre.push(...pp, `const ${b} = { v: ${lv} };`); argv.push(b); back.push(`${lv} = ${b}.v;`);
            } else { const t = T(); pre.push(`const ${t} = ${expr(x, fn)};`); argv.push(t); }
          });
          const r = T();
          return `(() => { ${pre.join(' ')} const ${r} = f_${e.name}(${argv.join(', ')}); ${back.join(' ')} return ${r}; })()`;
        }
        if (e.wrap) return `(${expr(e.args[0], fn)})`;
        const a = e.args.map((x) => expr(x, fn));
        if (e.builtin) {
          switch (e.name) {
            case 'print': return `$print(${a[0]})`;
            case 'show': {
              const k = base(e.args[0].ty).k;
              if (k === 'Enum') return `$names_${e.args[0].ty.name}[(${a[0]}).$t]`;
              return k === 'Float' ? `$show_f(${a[0]})` : k === 'Str' ? a[0] : `String(${a[0]})`;
            }
            case 'len': return `(${a[0]}).length`;
            case 'byte_at': return `$byte_at(${a[0]}, ${a[1]}, ${L(e, fn)})`;
            case 'slice': return `$slice(${a[0]}, ${a[1]}, ${a[2]}, ${L(e, fn)})`;
            case 'from_byte': return `$from_byte(${a[0]}, ${L(e, fn)})`;
            case 'join': return `(${a[0]}).join(${a[1]})`;
            case 'parse_float': return `$parse_float(${a[0]}, ${L(e, fn)})`;
            case 'eprint': return `($flush(), $io.ewrite(${a[0]} + "\\n"))`;
            case 'args': return `$io.args.slice()`;
            case 'exit': return `$exit(${a[0]})`;
            case 'read_file': return `$read_file(${a[0]}, ${L(e, fn)})`;
            case 'file_exists': return `$io.exists(${a[0]})`;
            case 'write_file': return `$write_file(${a[0]}, ${a[1]}, ${L(e, fn)})`;
            case 'push': return `(${a[0]}).push(${a[1]})`;
            case 'pop': {
              const [pre, lv] = place(e.args[0], fn);
              const call = `$pop(${lv}, ${L(e, fn)})`;
              return pre.length ? `(() => { ${pre.join(' ')} return ${call}; })()` : call;
            }
            case 'array': {
              const el = e.ty.el;
              return `$array(${a[0]}, ${a[1]}, ${el && needsCopy(el) ? copyFn(el) : 'null'}, ${L(e, fn)})`;
            }
            case 'to_float': return `(${a[0]})`;
            case 'to_int': return `$to_int(${a[0]}, ${L(e, fn)})`;
            case 'sqrt': return `Math.sqrt(${a[0]})`;
            case 'assert': return `((${a[0]}) || $trap(${bin('assertion failed: ' + e.args[0].src)}, ${L(e, fn)}))`;
            case 'clock_ms': return `Date.now()`;
          }
        }
        return `f_${e.name}(${a.join(', ')})`;
      }
    }
    throw new Error('jsgen: ' + e.e);
  }

  // place -> [preStatements, lvalue]
  function place(e, fn) {
    if (e.e === 'ident') return [[], e.binding?.kind === 'inout' ? `p_${e.name}.v` : `v_${e.name}`];
    if (e.e === 'field') { const [pre, lv] = place(e.base, fn); return [pre, `${lv}.${e.name}`]; }
    const [pre, lv] = place(e.base, fn);
    const a = T(), i = T();
    return [[...pre, `const ${a} = ${lv};`, `const ${i} = $at(${a}, ${expr(e.idx, fn)}, ${L(e, fn)});`], `${a}[${i}]`];
  }

  function stmts(list, fn, ind) {
    return list.map((s) => stmt(s, fn, ind)).join('');
  }
  function stmt(s, fn, ind) {
    const I = '  '.repeat(ind);
    switch (s.s) {
      case 'let':
        return `${I}${s.mut ? 'let' : 'const'} ${s.name === '_' ? T() : `v_${s.name}`} = ${expr(s.init, fn)};\n`;
      case 'assign': {
        const [pre, lv] = place(s.target, fn);
        return `${I}{ ${pre.join(' ')} ${lv} = ${expr(s.value, fn)}; }\n`;
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
      case 'while':
        return `${I}while (${expr(s.cond, fn)}) {\n${stmts(s.body, fn, ind + 1)}${I}}\n`;
      case 'for': {
        if (s.range) {
          const end = T();
          return `${I}for (let v_${s.name} = ${expr(s.range.start, fn)}, ${end} = ${expr(s.range.end, fn)}; v_${s.name} ${s.range.inclusive ? '<=' : '<'} ${end}; v_${s.name}++) {\n${stmts(s.body, fn, ind + 1)}${I}}\n`;
        }
        const a = T(), k = T();
        return `${I}{ const ${a} = ${expr(s.iter, fn)};\n${I}for (let ${k} = 0; ${k} < ${a}.length; ${k}++) {\n${I}  const v_${s.name} = ${a}[${k}];\n${stmts(s.body, fn, ind + 1)}${I}} }\n`;
      }
      case 'match': {
        const m = T();
        let o = `${I}{ const ${m} = ${expr(s.expr, fn)};\n`;
        s.cases.forEach((c, k) => {
          const last = k === s.cases.length - 1;
          const cond = c.pat.wild || (last && s.exhaustive) ? null : `${m}.$t === ${c.variant?.index}`;
          const head = k === 0 ? (cond ? `${I}if (${cond}) ` : `${I}`) : (cond ? ` else if (${cond}) ` : ' else ');
          const binds = c.pat.wild ? '' : c.pat.binds.map((b, j) => b === '_' ? '' : `${I}  const v_${b} = ${m}.${c.variant.fields[j].name};\n`).join('');
          o += `${head}{\n${binds}${stmts(c.body, fn, ind + 1)}${I}}`;
        });
        return o + `\n${I}}\n`;
      }
      case 'return': return `${I}return${s.value ? ' ' + expr(s.value, fn) : ''};\n`;
      case 'break': return `${I}break;\n`;
      case 'continue': return `${I}continue;\n`;
    }
  }

  for (const f of program.fns) {
    const params = f.params.map((p) => `${p.inout ? 'p' : 'v'}_${p.name}`).join(', ');
    const hasContracts = f.requires.length || f.ensures.length;
    const bodyName = hasContracts ? `f_${f.name}$body` : `f_${f.name}`;
    out.push(`function ${bodyName}(${params}) {\n${stmts(f.body, label(f.name, f), 1)}${f.sig.ret.k !== 'Unit' ? `  $trap("missing return", ${JSON.stringify(label(f.name, f))}, ${f.line});\n` : ''}}`);
    if (hasContracts) {
      let w = `function f_${f.name}(${params}) {\n`;
      for (const r of f.requires) w += `  if (!(${expr(r, label(f.name, f))})) $trap(${bin('requires failed: ' + r.src)}, ${L(r, label(f.name, f))});\n`;
      w += `  const v_result = ${bodyName}(${params});\n`;
      for (const en of f.ensures) w += `  if (!(${expr(en, label(f.name, f))})) $trap(${bin('ensures failed: ' + en.src)}, ${L(en, label(f.name, f))});\n`;
      out.push(w + `  return v_result;\n}`);
    }
  }

  const consts = program.consts ?? [];
  out.push(consts.map((c) => `let g_${c.name};`).join('\n'));
  out.push(`function $init() {\n${consts.map((c) => `  g_${c.name} = ${expr(c.init, label(c.name, c))};\n`).join('')}}`);

  if (examples) {
    const list = [];
    for (const f of program.fns) {
      for (const ex of f.examples) {
        const where = JSON.stringify(f.name);
        const isEq = ex.e === 'bin' && ex.op === '==';
        const run = isEq
          ? `() => { const l = ${expr(ex.l, label(f.name, f))}; const r = ${expr(ex.r, label(f.name, f))}; return { ok: l === r, l: $display(l), r: $display(r) }; }`
          : `() => ({ ok: ${expr(ex, label(f.name, f))} })`;
        list.push(`{ fn: ${where}, line: ${ex.line}, src: ${JSON.stringify(ex.src)}, run: ${run} }`);
      }
    }
    out.push(`function $display(v) { return typeof v === "number" ? (Number.isInteger(v) && !Object.is(v,-0) ? String(v) : $show_f(v)) : JSON.stringify(v); }`);
    out.push(`return { examples: [${list.join(',\n')}], init: $init, Trap: $Trap, flush: $flush };`);
  } else {
    out.push(`return { main: () => { try { $init(); f_main(); } finally { $flush(); } }, Trap: $Trap };`);
  }

  return [...out.slice(0, 1), ...copyFns.values(), ...out.slice(1)].join('\n');
}
