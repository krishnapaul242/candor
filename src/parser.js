// Candor parser: tokens -> AST. Every block closes with a labeled `end`,
// and the label is checked, so structural mistakes are reported where they happen.
import { lex, CandorError } from './lexer.js';

const PRIM = new Set(['Int', 'Float', 'Bool', 'Str', 'Unit']);

export function parse(src) {
  const toks = lex(src);
  let p = 0;

  const peek = (o = 0) => toks[p + o];
  const at = (kind, value) => {
    const t = toks[p];
    return t.kind === kind && (value === undefined || t.value === value);
  };
  const atOp = (v) => at('op', v);
  const atKw = (v) => at('kw', v);
  const next = () => toks[p++];
  const describe = (t) => t.kind === 'nl' ? 'end of line' : t.kind === 'eof' ? 'end of file'
    : t.kind === 'str' ? `string "${t.value}"` : `'${t.value}'`;
  const fail = (message, hint, t = peek()) => {
    throw new CandorError({ severity: 'error', code: 'syntax', message, hint, line: t.line, col: t.col });
  };
  const expect = (kind, value, what) => {
    if (!at(kind, value)) fail(`expected ${what ?? `'${value}'`}, found ${describe(peek())}`);
    return next();
  };
  const expectIdent = (what) => {
    if (!at('ident')) {
      const t = peek();
      fail(`expected ${what}, found ${describe(t)}`, t.kind === 'kw' ? `'${t.value}' is a reserved word` : undefined);
    }
    return next();
  };
  const skipNl = () => { while (at('nl')) next(); };
  const endLine = () => {
    if (at('eof')) return;
    if (!at('nl')) fail(`expected end of line, found ${describe(peek())}`, 'one statement per line');
    skipNl();
  };
  const srcOf = (startTok) => src.slice(startTok.start, toks[p - 1].end);

  // `end <label> [name]` with mismatch diagnostics pointing at the opener.
  const closeBlock = (label, opener, name) => {
    if (!atKw('end')) {
      fail(`expected 'end ${label}${name ? ' ' + name : ''}' to close ${label} opened at line ${opener.line}, found ${describe(peek())}`);
    }
    const endTok = next();
    const got = peek();
    const gotLabel = got.kind === 'kw' || got.kind === 'ident' ? got.value : null;
    if (gotLabel !== label) {
      throw new CandorError({
        severity: 'error', code: 'end-label-mismatch', line: endTok.line, col: endTok.col,
        message: `'end ${gotLabel ?? ''}' does not match the open '${label}' from line ${opener.line}`,
        hint: `write 'end ${label}${name ? ' ' + name : ''}' here, or check for a missing 'end' inside this ${label}`,
      });
    }
    next();
    if (name !== undefined) {
      if (!at('ident') || peek().value !== name) {
        throw new CandorError({
          severity: 'error', code: 'end-label-mismatch', line: endTok.line, col: endTok.col,
          message: `expected 'end ${label} ${name}', found 'end ${label} ${at('ident') ? peek().value : ''}'`.trimEnd(),
          hint: `the ${label} opened at line ${opener.line} is named '${name}'`,
        });
      }
      next();
    }
  };

  function parseType() {
    const t = peek();
    if (atOp('[')) {
      next();
      const el = parseType();
      expect('op', ']');
      return { k: 'Arr', el, line: t.line, col: t.col };
    }
    const name = expectIdent('a type').value;
    if (PRIM.has(name)) return { k: name, line: t.line, col: t.col };
    return { k: 'Named', name, line: t.line, col: t.col };
  }

  function parseTypeDecl() {
    const kw = next(); // type
    const name = expectIdent('a type name').value;
    expect('op', '=');
    if (atKw('record')) {
      next(); endLine();
      const fields = [];
      while (!atKw('end') && !at('eof')) {
        const ft = expectIdent('a field name');
        expect('op', ':');
        fields.push({ name: ft.value, ty: parseType(), line: ft.line, col: ft.col });
        endLine();
      }
      closeBlock('type', kw, name);
      return { kind: 'record', name, fields, line: kw.line, col: kw.col };
    }
    if (atKw('enum')) {
      next(); endLine();
      const variants = [];
      while (!atKw('end') && !at('eof')) {
        const vt = expectIdent('a variant name');
        const fields = [];
        if (atOp('(')) {
          next();
          while (!atOp(')')) {
            const ft = expectIdent('a payload field name');
            expect('op', ':', `':' and a type (payload fields are named, e.g. Circle(radius: Float))`);
            fields.push({ name: ft.value, ty: parseType(), line: ft.line, col: ft.col });
            if (!atOp(')')) expect('op', ',');
          }
          next();
        }
        variants.push({ name: vt.value, fields, line: vt.line, col: vt.col });
        endLine();
      }
      closeBlock('type', kw, name);
      return { kind: 'enum', name, variants, line: kw.line, col: kw.col };
    }
    if (atKw('distinct')) {
      next();
      const base = parseType();
      return { kind: 'distinct', name, base, line: kw.line, col: kw.col };
    }
    fail(`expected 'record', 'enum' or 'distinct' after 'type ${name} ='`);
  }

  function parseFn() {
    const kw = next(); // fn
    const name = expectIdent('a function name').value;
    expect('op', '(');
    const params = [];
    while (!atOp(')')) {
      const inout = atKw('inout') && !!next();
      const pt = expectIdent('a parameter name');
      expect('op', ':', `':' and a type for parameter '${pt.value}' (all parameters are annotated)`);
      params.push({ name: pt.value, ty: parseType(), inout, line: pt.line, col: pt.col });
      if (!atOp(')')) expect('op', ',');
    }
    next();
    let ret = null;
    if (atOp('->')) { next(); ret = parseType(); }
    endLine();
    const fn = { name, params, ret, requires: [], ensures: [], examples: [], effects: [], body: [], line: kw.line, col: kw.col };
    for (;;) {
      if (atKw('requires')) { next(); fn.requires.push(parseExpr()); endLine(); }
      else if (atKw('ensures')) { next(); fn.ensures.push(parseExpr()); endLine(); }
      else if (atKw('example')) { next(); fn.examples.push(parseExpr()); endLine(); }
      else if (atKw('effects')) {
        next();
        do { const e = expectIdent('an effect name'); fn.effects.push({ name: e.value, line: e.line, col: e.col }); }
        while (atOp(',') && next());
        endLine();
      } else break;
    }
    fn.body = parseBlock();
    closeBlock('fn', kw, name);
    return fn;
  }

  // Statements until a block terminator ('end', 'else', 'case').
  function parseBlock() {
    const out = [];
    skipNl();
    while (!atKw('end') && !atKw('else') && !atKw('case') && !at('eof')) {
      out.push(parseStmt());
    }
    return out;
  }

  function parseStmt() {
    const t = peek();
    const base = { line: t.line, col: t.col };
    if (atKw('let') || atKw('var')) {
      next();
      const nt = expectIdent('a variable name');
      let ty = null;
      if (atOp(':')) { next(); ty = parseType(); }
      expect('op', '=', `'=' (every ${t.value} must be initialized)`);
      const init = parseExpr();
      endLine();
      return { s: 'let', mut: t.value === 'var', name: nt.value, ty, init, ...base };
    }
    if (atKw('if')) {
      next();
      const arms = [];
      let cond = parseExpr();
      expect('kw', 'then', `'then' after the if condition`);
      endLine();
      arms.push({ cond, body: parseBlock() });
      let els = null;
      while (atKw('else')) {
        next();
        if (atKw('if')) {
          next();
          cond = parseExpr();
          expect('kw', 'then', `'then' after the else-if condition`);
          endLine();
          arms.push({ cond, body: parseBlock() });
        } else {
          endLine();
          els = parseBlock();
          break;
        }
      }
      closeBlock('if', t);
      endLine();
      return { s: 'if', arms, els, ...base };
    }
    if (atKw('while')) {
      next();
      const cond = parseExpr();
      expect('kw', 'do', `'do' after the while condition`);
      endLine();
      const body = parseBlock();
      closeBlock('while', t);
      endLine();
      return { s: 'while', cond, body, ...base };
    }
    if (atKw('for')) {
      next();
      const nt = expectIdent('a loop variable');
      expect('kw', 'in');
      const first = parseExpr();
      let range = null;
      if (atOp('..<') || atOp('..=')) {
        const op = next().value;
        range = { start: first, end: parseExpr(), inclusive: op === '..=' };
      } else if (atOp('.')) {
        fail(`ranges are written 'a ..< b' (exclusive) or 'a ..= b' (inclusive)`);
      }
      expect('kw', 'do', `'do' after the for header`);
      endLine();
      const body = parseBlock();
      closeBlock('for', t);
      endLine();
      return range ? { s: 'for', name: nt.value, range, body, ...base }
        : { s: 'for', name: nt.value, iter: first, body, ...base };
    }
    if (atKw('match')) {
      next();
      const expr = parseExpr();
      endLine();
      const cases = [];
      while (atKw('case')) {
        const ct = next();
        let pat;
        const vt = expectIdent(`a variant name or '_'`);
        if (vt.value === '_') pat = { wild: true };
        else {
          const binds = [];
          if (atOp('(')) {
            next();
            while (!atOp(')')) {
              binds.push(expectIdent('a binding name').value);
              if (!atOp(')')) expect('op', ',');
            }
            next();
          }
          pat = { name: vt.value, binds };
        }
        endLine();
        cases.push({ pat, body: parseBlock(), line: ct.line, col: ct.col });
      }
      closeBlock('match', t);
      endLine();
      return { s: 'match', expr, cases, ...base };
    }
    if (atKw('return')) {
      next();
      const value = at('nl') || at('eof') ? null : parseExpr();
      endLine();
      return { s: 'return', value, ...base };
    }
    if (atKw('break') || atKw('continue')) {
      next(); endLine();
      return { s: t.value, ...base };
    }
    const e = parseExpr();
    if (atOp('=')) {
      next();
      const value = parseExpr();
      endLine();
      return { s: 'assign', target: e, value, ...base };
    }
    endLine();
    return { s: 'expr', expr: e, ...base };
  }

  // Precedence: or < and < not < compare < (+ - ++) < (* / %) < unary - < postfix
  function parseExpr() { return parseOr(); }
  function binLevel(ops, sub, nonAssoc = false) {
    return () => {
      const st = peek();
      let l = sub();
      while (ops.some((o) => at('op', o) || at('kw', o))) {
        const ot = next();
        const r = sub();
        l = { e: 'bin', op: ot.value, l, r, line: ot.line, col: ot.col, src: srcOf(st) };
        if (nonAssoc && ops.some((o) => at('op', o))) {
          fail(`comparisons don't chain; write 'a < b and b < c'`);
        }
      }
      return l;
    };
  }
  function parseNot() {
    if (atKw('not')) {
      const t = next();
      const x = parseNot();
      return { e: 'un', op: 'not', x, line: t.line, col: t.col, src: srcOf(t) };
    }
    return parseCmp();
  }
  function parseUnary() {
    if (atOp('-')) {
      const t = next();
      const x = parseUnary();
      return { e: 'un', op: '-', x, line: t.line, col: t.col, src: srcOf(t) };
    }
    return parsePostfix();
  }
  const parseMul = binLevel(['*', '/', '%'], parseUnary);
  const parseAdd = binLevel(['+', '-', '++'], parseMul);
  const parseCmp = binLevel(['==', '!=', '<', '<=', '>', '>='], parseAdd, true);
  const parseAnd = binLevel(['and'], parseNot);
  const parseOr = binLevel(['or'], parseAnd);

  function parsePostfix() {
    const st = peek();
    let e = parsePrimary();
    for (;;) {
      if (atOp('[')) {
        const t = next();
        const idx = parseExpr();
        expect('op', ']');
        e = { e: 'index', base: e, idx, line: t.line, col: t.col, src: srcOf(st) };
      } else if (atOp('.')) {
        const t = next();
        const name = expectIdent('a field name').value;
        e = { e: 'field', base: e, name, line: t.line, col: t.col, src: srcOf(st) };
      } else if (atOp('(')) {
        fail('only named functions can be called', 'functions are not values in Candor v0');
      } else return e;
    }
  }

  function parsePrimary() {
    const t = peek();
    const base = { line: t.line, col: t.col };
    const done = (node) => ({ ...node, ...base, src: srcOf(t) });
    if (at('int')) { next(); return done({ e: 'int', v: t.value }); }
    if (at('float')) { next(); return done({ e: 'float', v: t.value }); }
    if (at('str')) { next(); return done({ e: 'str', v: t.value }); }
    if (atKw('true') || atKw('false')) { next(); return done({ e: 'bool', v: t.value === 'true' }); }
    if (atOp('?')) {
      next();
      const nt = expectIdent(`a hole name after '?', e.g. ?exchange_rate`);
      return done({ e: 'hole', name: nt.value });
    }
    if (atOp('(')) {
      next();
      const inner = parseExpr();
      expect('op', ')');
      return inner;
    }
    if (atOp('[')) {
      next();
      const items = [];
      while (!atOp(']')) {
        items.push(parseExpr());
        if (!atOp(']')) expect('op', ',');
      }
      next();
      return done({ e: 'arr', items });
    }
    if (at('ident')) {
      next();
      if (atOp('(')) {
        next();
        const args = [], inout = [];
        while (!atOp(')')) {
          inout.push(atKw('inout') && !!next());
          args.push(parseExpr());
          if (!atOp(')')) expect('op', ',');
        }
        next();
        return done({ e: 'call', name: t.value, args, inout });
      }
      if (atOp('{')) {
        next();
        const fields = [];
        while (!atOp('}')) {
          const ft = expectIdent('a field name');
          expect('op', ':');
          fields.push({ name: ft.value, value: parseExpr(), line: ft.line, col: ft.col });
          if (!atOp('}')) expect('op', ',');
        }
        next();
        return done({ e: 'rec', name: t.value, fields });
      }
      return done({ e: 'ident', name: t.value });
    }
    fail(`expected an expression, found ${describe(t)}`);
  }

  // Top-level `let NAME: Type = expr` is a constant.
  function parseConst() {
    const t = peek();
    if (atKw('var')) fail(`top-level 'var' is not allowed; top-level names are constants`, `use 'let NAME: Type = ...'`);
    next();
    const nt = expectIdent('a constant name');
    if (!atOp(':')) fail(`top-level constant '${nt.value}' needs a type`, `write 'let ${nt.value}: Type = ...'`);
    next();
    const ty = parseType();
    expect('op', '=', `'=' (every constant must be initialized)`);
    const init = parseExpr();
    return { name: nt.value, ty, init, line: t.line, col: t.col };
  }

  const program = { types: [], fns: [], consts: [], uses: [] };
  skipNl();
  while (!at('eof')) {
    if (atKw('fn')) program.fns.push(parseFn());
    else if (atKw('let') || atKw('var')) program.consts.push(parseConst());
    else if (atKw('type')) program.types.push(parseTypeDecl());
    else if (atKw('use')) {
      const t = next();
      if (!at('str')) fail(`expected a module path after 'use', e.g. use "lexer.cnd"`);
      program.uses.push({ path: next().value, line: t.line, col: t.col });
    }
    else fail(`expected 'fn', 'type', 'let' or 'use' at top level, found ${describe(peek())}`, 'statements must be inside a function');
    endLine();
  }
  return program;
}
