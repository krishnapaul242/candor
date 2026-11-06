// Candor checker: types, effects, mutability, exhaustiveness, holes.
// Annotates the AST in place (e.ty, ident bindings, copy flags) for the backends.

export const Int = { k: 'Int' }, Float = { k: 'Float' }, Bool = { k: 'Bool' }, Str = { k: 'Str' }, Unit = { k: 'Unit' };
const ERR = { k: 'Err' };
export const Arr = (el) => ({ k: 'Arr', el });
const PRIMS = { Int, Float, Bool, Str, Unit };
export const KNOWN_EFFECTS = { io: 'console, program args, exit', fs: 'reading and writing files', time: 'reading the clock' };

export const tyStr = (t) => t.k === 'Arr' ? `[${tyStr(t.el)}]` : t.name ?? t.k;
export const tyEq = (a, b) => a.k === 'Err' || b.k === 'Err' ||
  (a.k === b.k && (a.k === 'Arr' ? tyEq(a.el, b.el) : a.name === b.name));
export const mangle = (t) => t.k === 'Arr' ? `A_${mangle(t.el)}` : t.k === 'Rec' ? `R_${t.name}` : t.k === 'Dist' ? `D_${t.name}`
  : t.k === 'Enum' ? `E_${t.name}` : t.k[0].toLowerCase();

// name -> { args: [Type|'any'...], ret, effects }  (special cases handled in checkCall)
const BUILTINS = {
  print: { params: [Str], ret: Unit, effects: ['io'] },
  show: { ret: Str },             // Int | Float | Bool | Str
  len: { ret: Int },              // [T] | Str
  push: { ret: Unit },            // (var [T], T)
  pop: { ret: null },             // (var [T]) -> T
  array: { ret: null },           // (Int, T) -> [T]
  to_float: { params: [Int], ret: Float },
  to_int: { params: [Float], ret: Int },
  sqrt: { params: [Float], ret: Float },
  assert: { params: [Bool], ret: Unit },
  clock_ms: { params: [], ret: Int, effects: ['time'] },
  byte_at: { params: [Str, Int], ret: Int },
  slice: { params: [Str, Int, Int], ret: Str },
  from_byte: { params: [Int], ret: Str },
  join: { params: [Arr(Str), Str], ret: Str },
  parse_float: { params: [Str], ret: Float },
  eprint: { params: [Str], ret: Unit, effects: ['io'] },
  args: { params: [], ret: Arr(Str), effects: ['io'] },
  exit: { params: [Int], ret: Unit, effects: ['io'] },
  read_file: { params: [Str], ret: Str, effects: ['fs'] },
  write_file: { params: [Str, Str], ret: Unit, effects: ['fs'] },
  file_exists: { params: [Str], ret: Bool, effects: ['fs'] },
};

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function suggest(name, candidates) {
  let best = null, bd = Infinity;
  for (const c of candidates) {
    const dist = editDistance(name.toLowerCase(), c.toLowerCase());
    if (dist < bd) { bd = dist; best = c; }
  }
  return best && bd <= Math.max(1, Math.floor(name.length / 3)) ? best : null;
}

import { dirname, relPath } from './loader.js';

// mod: { files: [{path}], uses: [[fileId]] } from the loader (single file if omitted)
export function check(program, mod = { files: [{ path: '' }], uses: [[]] }) {
  const diags = [];
  const holes = [];
  const types = new Map();     // name -> decl (with resolved field types)
  const variants = new Map();  // variant name -> { enumName, index, fields }
  const fns = new Map();       // name -> decl (with .sig)

  const err = (code, node, message, hint) =>
    diags.push({ severity: 'error', code, message, hint, file: node.file ?? 0, line: node.line, col: node.col });
  // A file may only name what it declares or what a file it directly `use`s declares.
  const fileOf = (n) => n.file ?? 0;
  // " (first defined in other.cnd:12)" when a duplicate's original lives in another file
  const elsewhere = (prev, dup) => prev && fileOf(prev) !== fileOf(dup) ? ` (first defined in ${mod.files[fileOf(prev)].path}:${prev.line})` : '';
  const checkVisible = (at, decl, name) => {
    const from = fileOf(at), to = fileOf(decl);
    if (from === to || mod.uses[from].includes(to)) return;
    const target = mod.files[to].path;
    err('not-imported', at, `'${name}' is defined in ${target}, which this file does not use`,
      `add 'use "${relPath(dirname(mod.files[from].path), target)}"' at the top of this file`);
  };

  // ---- types ----
  for (const td of program.types) {
    if (types.has(td.name) || PRIMS[td.name]) { err('duplicate', td, `type '${td.name}' is already defined${elsewhere(types.get(td.name), td)}`,
      PRIMS[td.name] ? `${td.name} is a built-in type; delete this declaration and use ${td.name} directly` : undefined); continue; }
    types.set(td.name, td);
  }
  const resolveType = (te) => {
    if (te.k === 'Arr') { const el = resolveType(te.el); return el.k === 'Err' ? ERR : Arr(el); }
    if (te.k !== 'Named') return PRIMS[te.k];
    const td = types.get(te.name);
    if (!td) {
      const s = suggest(te.name, [...types.keys(), ...Object.keys(PRIMS)]);
      err('unknown-type', te, `unknown type '${te.name}'`, s ? `did you mean '${s}'?` : undefined);
      return ERR;
    }
    checkVisible(te, td, te.name);
    return { k: td.kind === 'record' ? 'Rec' : td.kind === 'enum' ? 'Enum' : 'Dist', name: td.name };
  };
  // A distinct type has the representation of its base but is a separate type.
  const baseOf = (t) => (t.k === 'Dist' ? types.get(t.name).baseT ?? ERR : t);
  for (const td of types.values()) {
    const seen = new Set();
    const resolveFields = (fields, owner) => {
      for (const f of fields) {
        if (seen.has(f.name)) err('duplicate', f, `field '${f.name}' appears twice in ${owner}`);
        seen.add(f.name);
        f.t = resolveType(f.ty);
        if (f.t.k === 'Unit') err('unit-value', f, `fields cannot have type Unit`);
      }
    };
    if (td.kind === 'distinct') {
      td.baseT = resolveType(td.base);
      if (!['Int', 'Float', 'Str', 'Bool', 'Err'].includes(td.baseT.k)) {
        err('bad-distinct', td, `distinct types wrap Int, Float, Str or Bool, not ${tyStr(td.baseT)}`, 'use a record to wrap anything else');
        td.baseT = ERR;
      }
    } else if (td.kind === 'record') resolveFields(td.fields, `record ${td.name}`);
    else {
      td.variants.forEach((v, index) => {
        seen.clear();
        if (variants.has(v.name)) {
          err('duplicate', v, `variant '${v.name}' is already defined in enum ${variants.get(v.name).enumName}`,
            'variant names are global so that `case Foo` is never ambiguous');
        } else variants.set(v.name, { name: v.name, enumName: td.name, index, fields: v.fields, decl: v });
        resolveFields(v.fields, `variant ${v.name}`);
      });
    }
  }
  // records stored by value must not contain themselves
  const recCycle = (name, path) => {
    if (path.includes(name)) return [...path, name];
    const td = types.get(name);
    for (const f of td.fields) {
      if (f.t?.k === 'Rec') { const c = recCycle(f.t.name, [...path, name]); if (c) return c; }
    }
    return null;
  };
  for (const td of types.values()) {
    if (td.kind !== 'record') continue;
    const c = recCycle(td.name, []);
    if (c && c[0] === td.name) {
      err('recursive-record', td, `record '${td.name}' contains itself (${c.join(' -> ')})`,
        'records are plain values; use an enum (e.g. Leaf | Node(...)) or an array for recursive data');
    }
  }

  // ---- function signatures ----
  for (const fn of program.fns) {
    if (fns.has(fn.name) || BUILTINS[fn.name]) {
      err('duplicate', fn, `function '${fn.name}' is already defined${BUILTINS[fn.name] ? ' (built-in)' : elsewhere(fns.get(fn.name), fn)}`);
      continue;
    }
    if (variants.has(fn.name)) err('duplicate', fn, `'${fn.name}' is already an enum variant`);
    if (types.get(fn.name)?.kind === 'distinct') err('duplicate', fn, `'${fn.name}' is already a distinct type`);
    fns.set(fn.name, fn);
    const seen = new Set();
    const params = fn.params.map((pm) => {
      if (seen.has(pm.name)) err('duplicate', pm, `parameter '${pm.name}' appears twice`);
      seen.add(pm.name);
      const t = resolveType(pm.ty);
      if (t.k === 'Unit') err('unit-value', pm, 'parameters cannot have type Unit');
      return { name: pm.name, t, inout: !!pm.inout };
    });
    const effects = new Set();
    for (const e of fn.effects) {
      if (!KNOWN_EFFECTS[e.name]) {
        const s = suggest(e.name, Object.keys(KNOWN_EFFECTS));
        err('unknown-effect', e, `unknown effect '${e.name}'`,
          s ? `did you mean '${s}'?` : `known effects: ${Object.keys(KNOWN_EFFECTS).join(', ')}`);
      }
      effects.add(e.name);
    }
    fn.sig = { params, ret: fn.ret ? resolveType(fn.ret) : Unit, effects };
  }
  const main = fns.get('main');
  if (main && (main.params.length || main.sig.ret.k !== 'Unit')) {
    err('bad-main', main, `'main' must take no parameters and return Unit`);
  }

  // ---- bodies ----
  // A payload-free enum is a plain tag, so == and show are meaningful for it.
  const simpleEnum = (t) => t.k === 'Enum' && types.get(t.name).variants.every((v) => !v.fields.length);
  // == / != work on scalars, distinct types, payload-free enums, and arrays/records built from them.
  const comparable = (t) => ['Int', 'Float', 'Bool', 'Str', 'Dist', 'Err'].includes(t.k) || simpleEnum(t) ||
    (t.k === 'Arr' && comparable(t.el)) || (t.k === 'Rec' && types.get(t.name).fields.every((f) => comparable(f.t)));
  const isPlace = (e) => e.e === 'ident' || ((e.e === 'index' || e.e === 'field') && isPlace(e.base));
  const placeRoot = (e) => e.e === 'ident' ? e : placeRoot(e.base);
  const needsCopyAny = (t) => t.k === 'Arr' || t.k === 'Rec';
  // Copy discipline (value semantics without pervasive copying):
  //  - call arguments are *borrowed*: never copied (callees can't mutate params);
  //  - a value *escapes* when stored (var, push, literal field) or returned; escaping
  //    values are copied unless fresh. Literals and call results are always fresh.
  //  - a whole read of a var/inout place in other value positions is copied.
  const fresh = (e) => e.copy || !needsCopyAny(e.ty) || e.e === 'arr' || e.e === 'rec' || e.e === 'call';
  const escape = (e) => { if (!fresh(e)) e.copyIn = true; };
  const mutableKind = (b) => b && (b.kind === 'var' || b.kind === 'inout');
  const consts = new Map(); // constants checked so far: name -> binding

  class Ctx {
    constructor(fn, effects, where) {
      this.fn = fn; this.effects = effects; this.where = where;
      this.scopes = [new Map(consts), new Map()]; this.loops = 0;
    }
    lookup(name) {
      for (let i = this.scopes.length - 1; i >= 0; i--) { const b = this.scopes[i].get(name); if (b) return b; }
      return null;
    }
    declare(name, info, node) {
      if (name === '_') return;
      const prev = this.lookup(name);
      if (prev) {
        err('shadowing', node, `'${name}' is already defined at line ${prev.line}`,
          'Candor forbids shadowing so every name means one thing; pick a new name');
      }
      this.scopes[this.scopes.length - 1].set(name, { ...info, line: node.line });
    }
    push() { this.scopes.push(new Map()); }
    pop() { this.scopes.pop(); }
    visible() {
      const out = new Map();
      for (const s of this.scopes) for (const [k, v] of s) out.set(k, v);
      return out;
    }
  }

  const requireEffects = (ctx, needed, node, calleeDesc) => {
    for (const eff of needed) {
      if (ctx.effects.has(eff)) continue;
      if (ctx.where === 'constant') {
        err('effect-in-contract', node, `${calleeDesc} has effect '${eff}', but constant initializers must be pure`);
      } else if (ctx.where !== 'body') {
        err('effect-in-contract', node, `${calleeDesc} has effect '${eff}', but ${ctx.where} clauses must be pure`);
      } else {
        err('effect-missing', node, `${calleeDesc} needs effect '${eff}', but fn ${ctx.fn.name} does not declare it`,
          `add 'effects ${[...ctx.effects, eff].join(', ')}' to the header of fn ${ctx.fn.name} (line ${ctx.fn.line})`);
      }
    }
  };

  function expect(e, ctx, t, what, mode = 'value') {
    const got = checkExpr(e, ctx, t, mode);
    if (!tyEq(got, t)) {
      let hint;
      if (got.k === 'Int' && t.k === 'Float') hint = 'Candor has no implicit conversions; use to_float(...)';
      else if (got.k === 'Float' && t.k === 'Int') hint = 'use to_int(...) (truncates toward zero)';
      else if (t.k === 'Str' && ['Int', 'Float', 'Bool'].includes(got.k)) hint = 'use show(...) to make a Str';
      else if (t.k === 'Dist' && tyEq(got, baseOf(t))) hint = `wrap it: ${t.name}(...)`;
      else if (got.k === 'Dist' && tyEq(baseOf(got), t)) hint = `unwrap it with .value`;
      err('type-mismatch', e, `${what ?? 'expression'} has type ${tyStr(got)}, expected ${tyStr(t)}`, hint);
    }
    return got;
  }

  // mode: 'value' (copy whole reads of var places), 'borrow' (call argument), 'base' (a[i] / p.f base)
  function checkExpr(e, ctx, expected = null, mode = 'value') {
    const t = checkExprInner(e, ctx, expected);
    e.ty = t;
    if (mode === 'value' && isPlace(e) && mutableKind(placeRoot(e).binding)) e.copy = true; // backends copy only if the type needs it
    return t;
  }

  function checkExprInner(e, ctx, expected) {
    switch (e.e) {
      case 'int': return Int;
      case 'float': return Float;
      case 'str': return Str;
      case 'bool': return Bool;
      case 'hole': {
        if (!expected) {
          err('hole-untyped', e, `can't tell what type hole ?${e.name} should have`,
            `give it context, e.g. 'let ${e.name}: Float = ?${e.name}'`);
          return ERR;
        }
        holes.push({
          name: e.name, file: e.file ?? 0, type: tyStr(expected), fn: `${ctx.where === 'constant' ? 'const' : 'fn'} ${ctx.fn.name}`, line: e.line, col: e.col,
          scope: [...ctx.visible()].map(([n, b]) => ({ name: n, type: tyStr(b.t), kind: b.kind })),
        });
        return expected;
      }
      case 'ident': {
        const b = ctx.lookup(e.name);
        if (b) {
          e.binding = b;
          if (b.kind === 'const') checkVisible(e, b.decl, e.name);
          return b.t;
        }
        const v = variants.get(e.name);
        if (v) {
          if (v.fields.length) {
            err('arity', e, `variant ${e.name} carries ${v.fields.length} field(s); construct it as ${e.name}(${v.fields.map((f) => f.name).join(', ')})`);
            return ERR;
          }
          e.variant = v;
          checkVisible(e, v.decl, e.name);
          return { k: 'Enum', name: v.enumName };
        }
        const later = program.consts.find((c) => c.name === e.name);
        if (later) {
          err('const-order', e, `constant '${e.name}' is used before its definition (line ${later.line})`, `move the definition of ${e.name} above this use`);
          return ERR;
        }
        const s = suggest(e.name, [...ctx.visible().keys(), ...variants.keys()]);
        err('unknown-name', e, `unknown name '${e.name}'`,
          s ? `did you mean '${s}'?` : fns.has(e.name) ? `'${e.name}' is a function; call it with ()` : undefined);
        return ERR;
      }
      case 'call': return checkCall(e, ctx, expected);
      case 'rec': {
        const td = types.get(e.name);
        if (!td || td.kind !== 'record') {
          const s = suggest(e.name, [...types.values()].filter((x) => x.kind === 'record').map((x) => x.name));
          err('unknown-type', e, `'${e.name}' is not a record type`, s ? `did you mean '${s}'?` : undefined);
          for (const f of e.fields) checkExpr(f.value, ctx);
          return ERR;
        }
        checkVisible(e, td, td.name);
        const given = new Set();
        for (const f of e.fields) {
          const fd = td.fields.find((x) => x.name === f.name);
          if (!fd) {
            const s = suggest(f.name, td.fields.map((x) => x.name));
            err('unknown-field', f, `record ${td.name} has no field '${f.name}'`, s ? `did you mean '${s}'?` : `fields: ${td.fields.map((x) => x.name).join(', ')}`);
            checkExpr(f.value, ctx);
            continue;
          }
          if (given.has(f.name)) err('duplicate', f, `field '${f.name}' given twice`);
          given.add(f.name);
          expect(f.value, ctx, fd.t, `field '${f.name}'`);
          escape(f.value);
        }
        const missing = td.fields.filter((x) => !given.has(x.name)).map((x) => x.name);
        if (missing.length) err('missing-field', e, `record literal ${td.name} is missing: ${missing.join(', ')}`, 'every field must be given explicitly');
        return { k: 'Rec', name: td.name };
      }
      case 'arr': {
        let el = expected?.k === 'Arr' ? expected.el : null;
        if (!e.items.length) {
          if (!el) {
            err('cannot-infer', e, `can't infer the element type of []`, `annotate it, e.g. 'var xs: [Int] = []'`);
            return ERR;
          }
          return Arr(el);
        }
        if (!el) el = checkExpr(e.items[0], ctx);
        else expect(e.items[0], ctx, el, 'array element');
        for (const it of e.items.slice(1)) expect(it, ctx, el, 'array element');
        e.items.forEach(escape);
        if (el.k === 'Unit') err('unit-value', e, 'arrays of Unit are not allowed');
        return Arr(el);
      }
      case 'index': {
        const bt = checkExpr(e.base, ctx, null, 'base');
        const it = checkExpr(e.idx, ctx, Int);
        if (it.k !== 'Int' && it.k !== 'Err' && !(it.k === 'Dist' && baseOf(it).k === 'Int')) {
          err('type-mismatch', e.idx, `index has type ${tyStr(it)}, expected Int`, it.k === 'Float' ? 'use to_int(...) (truncates toward zero)' : undefined);
        }
        if (bt.k === 'Err') return ERR;
        if (bt.k !== 'Arr') {
          err('type-mismatch', e, `can only index arrays, not ${tyStr(bt)}`,
            bt.k === 'Str' ? 'use byte_at(s, i) for the byte as an Int, or slice(s, i, i + 1) for a one-byte Str' : undefined);
          return ERR;
        }
        return bt.el;
      }
      case 'field': {
        const bt = checkExpr(e.base, ctx, null, 'base');
        if (bt.k === 'Err') return ERR;
        if (bt.k === 'Dist') {
          if (e.name !== 'value') {
            err('unknown-field', e, `${bt.name} is a distinct ${tyStr(baseOf(bt))}; its only field is .value`);
            return ERR;
          }
          e.unwrap = true;
          return baseOf(bt);
        }
        if (bt.k !== 'Rec') {
          err('type-mismatch', e, `${tyStr(bt)} has no fields`, bt.k === 'Enum' ? 'use match to read enum payloads' : undefined);
          return ERR;
        }
        const fd = types.get(bt.name).fields.find((x) => x.name === e.name);
        if (!fd) {
          const s = suggest(e.name, types.get(bt.name).fields.map((x) => x.name));
          err('unknown-field', e, `record ${bt.name} has no field '${e.name}'`, s ? `did you mean '${s}'?` : undefined);
          return ERR;
        }
        return fd.t;
      }
      case 'un': {
        if (e.op === 'not') { expect(e.x, ctx, Bool, `operand of 'not'`); return Bool; }
        const t = checkExpr(e.x, ctx, expected);
        if (t.k !== 'Int' && t.k !== 'Float' && t.k !== 'Err') err('type-mismatch', e, `can't negate ${tyStr(t)}`);
        return t;
      }
      case 'bin': return checkBin(e, ctx, expected);
    }
    throw new Error('unknown expr ' + e.e);
  }

  function checkBin(e, ctx, expected) {
    const { op } = e;
    if (op === 'and' || op === 'or') {
      expect(e.l, ctx, Bool, `left side of '${op}'`);
      expect(e.r, ctx, Bool, `right side of '${op}'`);
      return Bool;
    }
    if (op === '++') {
      expect(e.l, ctx, Str, `left side of '++'`);
      expect(e.r, ctx, Str, `right side of '++'`);
      return Str;
    }
    const numHint = expected && (expected.k === 'Int' || expected.k === 'Float') ? expected : null;
    const lt = checkExpr(e.l, ctx, ['==', '!='].includes(op) ? null : numHint);
    const rt = checkExpr(e.r, ctx, lt.k === 'Err' ? null : lt);
    if (lt.k === 'Err' || rt.k === 'Err') return ['+', '-', '*', '/', '%'].includes(op) ? (lt.k === 'Err' ? rt : lt) : Bool;
    if (!tyEq(lt, rt)) {
      const hint = (lt.k === 'Int' && rt.k === 'Float') || (lt.k === 'Float' && rt.k === 'Int')
        ? 'Candor never converts implicitly; wrap the Int side in to_float(...)'
        : op === '+' && (lt.k === 'Str' || rt.k === 'Str') ? `use '++' to join strings and show(...) to convert` : undefined;
      err('type-mismatch', e, `'${op}' needs both sides to have the same type, got ${tyStr(lt)} and ${tyStr(rt)}`, hint);
      return ['+', '-', '*', '/', '%'].includes(op) ? lt : Bool;
    }
    if (lt.k === 'Dist' && ['+', '-', '*', '/', '%'].includes(op)) {
      err('type-mismatch', e, `'${op}' doesn't work on distinct type ${lt.name}`,
        `ids aren't numbers; if you mean it, unwrap and rewrap: ${lt.name}(a.value ${op} b.value)`);
      return lt;
    }
    if (['+', '-', '*', '/'].includes(op)) {
      if (lt.k !== 'Int' && lt.k !== 'Float') {
        err('type-mismatch', e, `'${op}' works on Int or Float, not ${tyStr(lt)}`, lt.k === 'Str' && op === '+' ? `use '++' to join strings` : undefined);
      }
      return lt;
    }
    if (op === '%') {
      if (lt.k !== 'Int') err('type-mismatch', e, `'%' works on Int, not ${tyStr(lt)}`);
      return lt;
    }
    if (op === '==' || op === '!=') {
      if (!comparable(lt)) {
        err('type-mismatch', e, `'${op}' can't compare ${tyStr(lt)}: it contains an enum with payloads`,
          lt.k === 'Enum' ? `${lt.name} has variants with payloads; use match to inspect them` : 'compare the parts you care about, or use match on the enum values');
      }
      return Bool;
    }
    const lb = baseOf(lt);
    if (lb.k !== 'Int' && lb.k !== 'Float' && lb.k !== 'Err') err('type-mismatch', e, `'${op}' orders Int or Float, not ${tyStr(lt)}`);
    return Bool;
  }

  function checkCall(e, ctx, expected) {
    const n = e.args.length;
    const arity = (want) => {
      if (n !== want) { err('arity', e, `${e.name} takes ${want} argument(s), got ${n}`); return false; }
      return true;
    };
    const v = variants.get(e.name);
    if (v) {
      e.variant = v;
      checkVisible(e, v.decl, e.name);
      if (arity(v.fields.length)) v.fields.forEach((f, i) => { expect(e.args[i], ctx, f.t, `${e.name}.${f.name}`); escape(e.args[i]); });
      else e.args.forEach((a) => checkExpr(a, ctx));
      return { k: 'Enum', name: v.enumName };
    }
    const b = BUILTINS[e.name];
    if (b) {
      e.builtin = true;
      requireEffects(ctx, b.effects ?? [], e, `${e.name}(...)`);
      if (b.params) {
        if (arity(b.params.length)) b.params.forEach((pt, i) => expect(e.args[i], ctx, pt, `argument ${i + 1} of ${e.name}`, 'borrow'));
        return b.ret;
      }
      if (e.name === 'show') {
        if (!arity(1)) return Str;
        const t = checkExpr(e.args[0], ctx);
        if (!['Int', 'Float', 'Bool', 'Str', 'Err', 'Dist'].includes(t.k) && !simpleEnum(t)) {
          err('type-mismatch', e, `show works on Int, Float, Bool, Str, distinct types and payload-free enums; not ${tyStr(t)}`, 'write a describe function for your type');
        }
        return Str;
      }
      if (e.name === 'len') {
        if (!arity(1)) return Int;
        const t = checkExpr(e.args[0], ctx, null, 'borrow');
        if (t.k !== 'Arr' && t.k !== 'Str' && t.k !== 'Err') err('type-mismatch', e, `len works on arrays and Str, not ${tyStr(t)}`);
        return Int;
      }
      if (e.name === 'push') {
        if (!arity(2)) return Unit;
        const tgt = e.args[0];
        const t = checkExpr(tgt, ctx, null, 'base');
        checkMutablePlace(tgt, ctx, 'push to');
        if (t.k === 'Err') { checkExpr(e.args[1], ctx); return Unit; }
        if (t.k !== 'Arr') { err('type-mismatch', tgt, `push needs an array, got ${tyStr(t)}`); return Unit; }
        expect(e.args[1], ctx, t.el, 'pushed value');
        escape(e.args[1]);
        return Unit;
      }
      if (e.name === 'pop') {
        if (!arity(1)) return ERR;
        const tgt = e.args[0];
        const t = checkExpr(tgt, ctx, null, 'base');
        checkMutablePlace(tgt, ctx, 'pop from');
        if (t.k === 'Err') return ERR;
        if (t.k !== 'Arr') { err('type-mismatch', tgt, `pop needs an array, got ${tyStr(t)}`); return ERR; }
        return t.el;
      }
      if (e.name === 'array') {
        if (!arity(2)) return ERR;
        expect(e.args[0], ctx, Int, 'array length');
        const el = checkExpr(e.args[1], ctx, expected?.k === 'Arr' ? expected.el : null, 'borrow');
        if (el.k === 'Unit') err('unit-value', e, 'arrays of Unit are not allowed');
        return el.k === 'Err' ? ERR : Arr(el);
      }
    }
    const dt = types.get(e.name);
    if (dt && dt.kind === 'distinct') {
      e.wrap = true;
      checkVisible(e, dt, dt.name);
      if (arity(1)) expect(e.args[0], ctx, dt.baseT ?? ERR, `value wrapped in ${dt.name}`);
      else e.args.forEach((a) => checkExpr(a, ctx));
      return { k: 'Dist', name: dt.name };
    }
    const fn = fns.get(e.name);
    if (!fn) {
      const s = suggest(e.name, [...fns.keys(), ...Object.keys(BUILTINS), ...variants.keys()]);
      err('unknown-function', e, `unknown function '${e.name}'`,
        s ? `did you mean '${s}'?` : `built-ins: ${Object.keys(BUILTINS).join(', ')}`);
      e.args.forEach((a) => checkExpr(a, ctx));
      return ERR;
    }
    e.fn = fn;
    checkVisible(e, fn, fn.name);
    if (ctx.where === 'constant') {
      err('const-init', e, `constant ${ctx.fn.name} can't call fn ${fn.name}`, 'constant initializers may use literals, operators, other constants and pure built-ins');
    }
    requireEffects(ctx, fn.sig.effects, e, `fn ${fn.name}`);
    if (!arity(fn.sig.params.length)) { e.args.forEach((a) => checkExpr(a, ctx, null, 'borrow')); return fn.sig.ret; }
    const inoutRoots = new Map();
    fn.sig.params.forEach((pm, i) => {
      const a = e.args[i];
      if (pm.inout) {
        if (!e.inout[i]) {
          err('inout-mismatch', a, `parameter '${pm.name}' of ${fn.name} is inout; the call must say so`,
            `write '${fn.name}(..., inout ${a.src ?? pm.name}, ...)' so the mutation is visible here`);
        }
        const t = checkExpr(a, ctx, null, 'base');
        checkMutablePlace(a, ctx, 'pass as inout');
        if (!tyEq(t, pm.t)) err('type-mismatch', a, `inout argument '${pm.name}' has type ${tyStr(t)}, expected ${tyStr(pm.t)}`, 'inout types must match exactly');
        if (isPlace(a)) {
          const r = placeRoot(a).name;
          if (inoutRoots.has(r)) err('inout-alias', a, `'${r}' is passed as inout twice in one call`, 'each inout argument must be a different variable');
          inoutRoots.set(r, i);
        }
      } else {
        if (e.inout[i]) err('inout-mismatch', a, `parameter '${pm.name}' of ${fn.name} is not inout`, `remove 'inout' here`);
        expect(a, ctx, pm.t, `argument '${pm.name}' of ${fn.name}`, 'borrow');
      }
    });
    e.args.forEach((a, i) => {
      if (!fn.sig.params[i].inout && isPlace(a) && needsCopyAny(a.ty) && inoutRoots.has(placeRoot(a).name)) {
        err('inout-alias', a, `'${placeRoot(a).name}' is borrowed here while also passed as inout in the same call`,
          `copy it into a let first: 'let ${placeRoot(a).name}_now = ${placeRoot(a).name}'`);
      }
    });
    return fn.sig.ret;
  }

  function checkMutablePlace(tgt, ctx, verb) {
    if (!isPlace(tgt)) { err('not-assignable', tgt, `can only ${verb} a variable, field or element`); return; }
    for (let p = tgt; p.e !== 'ident'; p = p.base) {
      if (p.e === 'field' && p.unwrap) {
        err('not-assignable', tgt, `the .value of a distinct type is read-only`, `assign a whole new value instead, e.g. x = ${p.base.ty.name}(...)`);
        return;
      }
    }
    const root = placeRoot(tgt);
    const b = root.binding;
    if (b && !mutableKind(b)) {
      err('immutable', tgt, `can't ${verb} '${root.name}': it is ${b.kind === 'let' ? 'a let binding' : b.kind === 'param' ? 'a parameter' : b.kind === 'const' ? 'a constant' : 'immutable'}`,
        b.kind === 'param' || b.kind === 'const' ? `copy it first: 'var ${root.name}2 = ${root.name}'` : `declare it with 'var' (line ${b.line})`);
    }
  }

  // Does this statement list always end in return?
  const hasBreak = (stmts) => stmts.some((s) => s.s === 'break' ||
    (s.s === 'if' && (s.arms.some((a) => hasBreak(a.body)) || (s.els && hasBreak(s.els)))) ||
    (s.s === 'match' && s.cases.some((c) => hasBreak(c.body))));
  const returns = (stmts) => stmts.some((s) =>
    s.s === 'return' ||
    (s.s === 'if' && s.els && s.arms.every((a) => returns(a.body)) && returns(s.els)) ||
    (s.s === 'match' && s.exhaustive && s.cases.every((c) => returns(c.body))) ||
    (s.s === 'while' && s.cond.e === 'bool' && s.cond.v && !hasBreak(s.body)));

  function checkBlock(stmts, ctx) {
    ctx.push();
    for (const s of stmts) checkStmt(s, ctx);
    ctx.pop();
  }

  function checkStmt(s, ctx) {
    switch (s.s) {
      case 'let': {
        let t;
        if (s.ty) { t = resolveType(s.ty); if (t.k !== 'Err') expect(s.init, ctx, t, `value of '${s.name}'`); else checkExpr(s.init, ctx); }
        else t = checkExpr(s.init, ctx);
        if (t.k === 'Unit') err('unit-value', s, `'${s.name}' would have type Unit`, 'call the function as a statement instead');
        if (s.mut) escape(s.init);
        ctx.declare(s.name, { t, kind: s.mut ? 'var' : 'let' }, s);
        s.t = t;
        return;
      }
      case 'assign': {
        const t = checkExpr(s.target, ctx, null, 'base');
        checkMutablePlace(s.target, ctx, 'assign to');
        if (t.k !== 'Err') expect(s.value, ctx, t, 'assigned value'); else checkExpr(s.value, ctx);
        escape(s.value);
        return;
      }
      case 'expr': {
        if (s.expr.e === 'hole') {
          err('hole-untyped', s.expr, `a hole can't stand alone as a statement`, `use it where a value of known type is needed`);
          return;
        }
        const t = checkExpr(s.expr, ctx);
        if (s.expr.e !== 'call') {
          err('unused-value', s, `this expression does nothing`, s.expr.e === 'bin' && s.expr.op === '==' ? `did you mean '=' (assignment)?` : undefined);
        } else if (t.k !== 'Unit' && t.k !== 'Err') {
          err('unused-value', s, `result of ${s.expr.name}(...) (${tyStr(t)}) is ignored`, `write 'let _ = ${s.expr.name}(...)' to discard it on purpose`);
        }
        return;
      }
      case 'if':
        for (const a of s.arms) { expect(a.cond, ctx, Bool, 'if condition'); checkBlock(a.body, ctx); }
        if (s.els) checkBlock(s.els, ctx);
        return;
      case 'while':
        expect(s.cond, ctx, Bool, 'while condition');
        ctx.loops++; checkBlock(s.body, ctx); ctx.loops--;
        return;
      case 'for': {
        let t;
        if (s.range) {
          expect(s.range.start, ctx, Int, 'range start');
          expect(s.range.end, ctx, Int, 'range end');
          t = Int;
        } else {
          const it = checkExpr(s.iter, ctx);
          if (it.k !== 'Arr' && it.k !== 'Err') err('type-mismatch', s.iter, `can only loop over arrays or ranges, not ${tyStr(it)}`, `for a count, write 'for i in 0 ..< n do'`);
          t = it.k === 'Arr' ? it.el : ERR;
        }
        s.t = t;
        ctx.push();
        ctx.declare(s.name, { t, kind: 'let' }, s);
        ctx.loops++; checkBlock(s.body, ctx); ctx.loops--;
        ctx.pop();
        return;
      }
      case 'match': {
        const t = checkExpr(s.expr, ctx);
        if (t.k === 'Err') { s.cases.forEach((c) => checkBlock(c.body, ctx)); return; }
        if (t.k !== 'Enum') { err('type-mismatch', s.expr, `match works on enums, not ${tyStr(t)}`, 'use if / else if for other values'); return; }
        const td = types.get(t.name);
        const covered = new Set();
        let wild = false;
        for (const c of s.cases) {
          ctx.push();
          if (wild) err('unreachable', c, `case after '_' can never run`);
          if (c.pat.wild) wild = true;
          else {
            const v = variants.get(c.pat.name);
            if (!v || v.enumName !== t.name) {
              const s2 = suggest(c.pat.name, td.variants.map((x) => x.name));
              err('unknown-variant', c, `${t.name} has no variant '${c.pat.name}'`, s2 ? `did you mean '${s2}'?` : `variants: ${td.variants.map((x) => x.name).join(', ')}`);
            } else {
              c.variant = v;
              checkVisible(c, v.decl, v.name);
              if (covered.has(v.name)) err('duplicate', c, `variant ${v.name} is matched twice`);
              covered.add(v.name);
              if (c.pat.binds.length !== v.fields.length) {
                err('arity', c, `${v.name} has ${v.fields.length} field(s) (${v.fields.map((f) => f.name).join(', ')}), pattern binds ${c.pat.binds.length}`);
              }
              c.pat.binds.forEach((bn, i) => { if (v.fields[i]) ctx.declare(bn, { t: v.fields[i].t, kind: 'let' }, c); });
            }
          }
          checkBlock(c.body, ctx);
          ctx.pop();
        }
        const missing = td.variants.filter((v) => !covered.has(v.name)).map((v) => v.name);
        s.exhaustive = wild || missing.length === 0;
        if (!s.exhaustive) err('non-exhaustive', s, `match on ${t.name} is missing: ${missing.join(', ')}`, `add 'case ${missing[0]}${variants.get(missing[0]).fields.length ? '(...)' : ''}' or 'case _'`);
        return;
      }
      case 'return': {
        const rt = ctx.fn.sig.ret;
        if (s.value) {
          if (rt.k === 'Unit') { err('type-mismatch', s, `fn ${ctx.fn.name} returns Unit; it can't return a value`, `add '-> Type' to the signature`); checkExpr(s.value, ctx); }
          else {
            expect(s.value, ctx, rt, 'returned value');
            // returning a local var directly: it dies here, so no copy is needed
            if (s.value.e === 'ident' && s.value.binding?.kind === 'var') s.value.copy = false;
            else escape(s.value);
          }
        } else if (rt.k !== 'Unit') err('type-mismatch', s, `fn ${ctx.fn.name} must return a ${tyStr(rt)}`);
        return;
      }
      case 'break': case 'continue':
        if (!ctx.loops) err('outside-loop', s, `'${s.s}' outside a loop`);
        return;
    }
  }

  for (const c of program.consts) {
    if (consts.has(c.name)) err('duplicate', c, `constant '${c.name}' is already defined${elsewhere(consts.get(c.name).decl, c)}`);
    else if (variants.has(c.name)) err('duplicate', c, `'${c.name}' is already an enum variant`);
    c.t = resolveType(c.ty);
    if (c.t.k === 'Unit') err('unit-value', c, 'constants cannot have type Unit');
    const ctx = new Ctx({ name: c.name, line: c.line }, new Set(), 'constant');
    if (c.t.k !== 'Err') expect(c.init, ctx, c.t, `value of '${c.name}'`); else checkExpr(c.init, ctx);
    if (!consts.has(c.name)) consts.set(c.name, { t: c.t, kind: 'const', line: c.line, decl: c });
  }

  for (const fn of program.fns) {
    if (!fn.sig) continue;
    const declareParams = (ctx) => fn.sig.params.forEach((pm, i) => ctx.declare(pm.name, { t: pm.t, kind: pm.inout ? 'inout' : 'param' }, fn.params[i]));
    const ctx = new Ctx(fn, fn.sig.effects, 'body');
    declareParams(ctx);
    checkBlock(fn.body, ctx);
    if (fn.sig.ret.k !== 'Unit' && !returns(fn.body)) {
      err('missing-return', fn, `fn ${fn.name} can reach its end without returning a ${tyStr(fn.sig.ret)}`, 'make sure every branch ends in return');
    }
    const pure = new Set();
    for (const r of fn.requires) {
      const c = new Ctx(fn, pure, 'requires'); declareParams(c); expect(r, c, Bool, 'requires clause');
    }
    for (const en of fn.ensures) {
      const c = new Ctx(fn, pure, 'ensures'); declareParams(c);
      if (fn.sig.ret.k !== 'Unit') c.declare('result', { t: fn.sig.ret, kind: 'let' }, en);
      expect(en, c, Bool, 'ensures clause');
    }
    for (const ex of fn.examples) {
      const c = new Ctx(fn, pure, 'example'); expect(ex, c, Bool, 'example');
    }
  }

  diags.sort((a, b) => a.file - b.file || a.line - b.line || a.col - b.col);
  return { diags, holes, types, variants, fns };
}
