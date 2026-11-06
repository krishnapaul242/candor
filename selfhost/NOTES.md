# Writing Candor in Candor: field notes

The point of self-hosting was to find out whether the language holds up for a real program. A compiler is about as real as it gets. These notes record what I (Claude) ran into while writing `candorc`.

## Result

- 3,650 lines and 165 functions. The first type check found **one** error: I had used the reserved word `effects` as a field name, and the hint said so.
- After that fix, it compiled, passed every comparison test against the JS compiler, and reached a byte-identical bootstrap fixed point **on the first full run**. No compiler bug had to be debugged.
- An important caveat: I was **porting** a design I had just written in JS, not inventing one. That is much easier than writing a compiler from scratch, so the clean first run says less about Candor than it seems to. The pain points below are the more trustworthy signal.

## What worked

- **`inout` plus borrowed arguments.** The whole compiler threads its state through `inout p: P`, `inout cx: Cx` and `inout g: G`. Every mutation is visible at the call site, and passing the full AST to a read-only helper costs nothing. Before borrows, v0 would have deep-copied the AST on every helper call. The self-built compiler compiles itself in about 10 ms.
- **Required `let _ =` for discarded results.** It's noisy (see below), but every discard is visible, and I never accidentally ignored a value I needed.
- **Labeled `end`s.** In a 3,650-line file I never lost track of a block. The `end fn name` labels work as landmarks when reading the file back.
- **Ban on shadowing.** It forced distinct names (`t`, `t2`, `t3` in long `if` chains). That's ugly, but no variable ever meant two things.

## What hurt, ranked by how much it would change the code

1. **Enums were too rigid for the compiler's own data, so the AST is stringly typed.** Enum values can't be compared with `==`, can't be annotated after creation, and can't be partially updated. So the AST is an arena of one generic `Node` record with `kind: Str`. A typo like `"fielddecl"` vs `"field_decl"` would be a silent bug, and match exhaustiveness checking — Candor's own selling point — goes unused across the whole compiler. **Fix:** allow `==` on payload-less enums and add enum-typed fields to records, so `kind: NodeKind` becomes possible.
2. **No named constants.** Type ids (`0` = Err … `6` = `[Str]`) and binding kinds (`1` = var … `4` = inout) are magic numbers. Mixing them up would type-check fine. **Fix:** top-level `let` constants, or the enum fix above.
3. **No error propagation.** The parser can't throw, so a `failed` flag is threaded everywhere and every loop checks `not p.failed`. Without generics there's no `Result[T]` to return instead. **Fix:** generics (`Option[T]`, `Result[T]`), or a checked `fail` effect.
4. **No modules.** The compiler is six files glued together with `cat`, so line numbers in diagnostics refer to the combined file. **Fix:** `use "lexer.cnd"`.
5. **No closures.** In `cgen.js`, `seq(parts, vals => ...)` became a `Seq` record plus a `seq_wrap` helper in Candor. That's workable, but every call site has two steps.
6. **No array `pop` or truncate.** Scopes use a logical length plus a stack of marks rebuilt by copying. **Fix:** a `pop(var_array)` builtin, which is easy.
7. **`let _ = next_tok(inout p)` appears 100+ times.** Discarding is visible, which is good, but this case is so common that it's noise. A function could declare that its result may be ignored.

## Update: enums fixed, and the compiler's internals rewritten with them

**Language change:** `==`, `!=` and `show` now work on payload-free enums. (Enum-typed record fields already worked; what was missing was any way to compare them.) Both compilers got the change, plus `tests/run/enums.cnd` and `tests/errors/enum_eq.cnd`.

**Rewrite of candorc:** string kinds and magic numbers became enums: `TokKind`, `NodeKind` (39 variants), `Bind`, `RefKind`, `Mode` and `TyKind`. Fixed type ids became named helpers (`t_int()`), and the 7-slot fn node layout got accessors (`fn_effects(ast, f)`). About 330 sites changed.

**What the type checker did:** I made the bulk change with a regex script, which is the kind of change that usually leaves silent bugs behind. The checker reported **every** site the script missed or got wrong: 104 errors at first, 27 after adding the type-id helpers, each a real `TyKind`-vs-`Str` or `Bind`-vs-`Int` mismatch. After fixing those, the rewritten compiler passed all 28 checks and reached a new fixed point **on the first run**. Before the change, the same mistakes would have compiled fine and failed somewhere at runtime.

`ctype`, `ty_str` and `mangle` are now `match`es over `TyKind`, so adding a new type kind fails to compile until each of them handles it.

**What this still doesn't buy:** the big dispatchers (`check_stmt`, `gx_inner`, `gen_stmt`) remain `if` chains over one flat `NodeKind`. Exhaustiveness checking would only help if statements, expressions and types each had their own enum. That needs per-category node types, and that in turn needs either generics or enums with payloads that can be updated. Integer type ids also remain plain `Int`s, since a fixed id can't be checked against the type it means.

## Suggested next version, in order

1. ~~`==` on payload-less enums~~ (done, see above).
2. ~~`pop`, and top-level constants~~ (done, see below).
3. Modules (`use`).
4. Generics, starting with `Option[T]` and `Result[T]`. This is the biggest change, and the one that would clean up error handling.

## Update: constants and `pop`

**Language change:** top-level `let NAME: Type = expr` constants, and `pop(var_array)`. Constant initializers can't call functions. That rule means initialization order never needs to be thought about: a constant can only see constants defined above it, and nothing can run before all of them are set. Constants also follow the no-shadowing rule, so a local named `LIMIT` is an error if a constant `LIMIT` exists. New error codes: `const-order` and `const-init`.

**In candorc:**
- The `t_int()` … `t_strs()` helper functions became `T_INT` … `T_STRS` constants.
- `sc_pop`, which used to rebuild the scope-mark stack by copying, is now one line: `cx.sc_n = pop(cx.sc_marks)`.

Both compilers implement the change, there are run and error tests for each new diagnostic, and the bootstrap reached a fixed point again.

**What remains magic:** the type ids themselves are still `Int`s, so `T_INT` and an AST node index are interchangeable to the checker. A distinct type for ids (`type TyId = Int`, not interchangeable with `Int`) would close that gap cheaply.

## Update: modules (v0.3)

**Language change:** `use "path.cnd"`, with direct visibility. Names stay globally unique, but a file can only *name* what it declares or what a file it directly `use`s declares, and the `not-imported` error gives the `use` line to add. Diagnostics, hole reports and traps now name the real file (`trap in ratio at geometry.cnd:15: ...`). One new builtin, `file_exists`, lets candorc report a missing module instead of crashing on `read_file`.

**In candorc:** the six `NN_*.cnd` sections became real modules (`util`, `lexer`, `parser`, `check`, `cgen`, `candorc`), and `build.sh` is deleted. I wrote each file's `use` lines by guessing from the old layering, and they were all right the first time: the sections were already layered cleanly, so the split was mechanical. To confirm the rule actually bites, I deleted `use "check.cnd"` from `cgen.cnd`, which produced 165 `not-imported` errors.

**New pain point, measured:** the loader parses each module into a shared AST arena. Getting that arena into the parser state and back out again copies it, because Candor can't *move* a value. Peak memory for a self-compile went from 36 MB to 54 MB. Copy-on-write (v0.6) would make this free. A cheaper stopgap would be letting `inout` reach into the parser, so the arena is never handed over at all.

Each change goes into both compilers. The self-hosting test guarantees they stay in agreement, so the language can now evolve using itself.
