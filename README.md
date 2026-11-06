# Candor

A programming language designed by a language model, for a language model (and the humans who review its code).

**Docs:** [krishnapaul.in/candor](https://krishnapaul.in/candor/), with a [language guide](https://krishnapaul.in/candor/guide.html), [self-hosting](https://krishnapaul.in/candor/selfhosting.html) and the [roadmap](https://krishnapaul.in/candor/roadmap.html) ([`ROADMAP.md`](ROADMAP.md)).

Current languages are tuned so humans can **write** code quickly. Candor is tuned so humans can **verify** code someone else wrote. Every design choice targets one of the ways an LLM actually gets code wrong.

| LLM failure mode | Candor's answer |
|---|---|
| Hidden side effects far from the call site | `effects io, time` in the signature, checked transitively. No clause means the function is pure. |
| Making up a plausible API when unsure | Typed holes: `?exchange_rate`. They type-check, list what's in scope, trap if reached, and block `build`. |
| Code that *looks* right | `requires` / `ensures` contracts checked at runtime, plus `example` clauses run by `candor test`. |
| Losing track of nesting in long blocks | Labeled ends: `end fn name`, `end if`, `end while`. A mismatch points at the opener. |
| Silent coercions, truthiness, overflow | No implicit conversions. Int overflow, bad indexes and divide-by-zero **trap** with fn, file and line. |
| "Where does this name come from?" | `use "lexer.cnd"`: a file can only name what it declares or what a file it directly uses declares, and the error says which `use` to add. |
| Aliasing bugs | Value semantics: `let b = a` then `push(a, 4)` never changes `b`. |
| Mutation at a distance | A function can only change a caller's variable through an `inout` parameter, and the **call site** must say `inout` too. |
| Off-by-one ranges | Explicit `0 ..< n` (exclusive) vs `1 ..= n` (inclusive). |
| Name confusion | No shadowing, globally unique enum variants, "did you mean" suggestions, `--json` diagnostics. |

## Usage

```sh
node src/cli.js check examples/tour.cnd          # types, effects, holes (add --json for tools)
node src/cli.js run   examples/tour.cnd          # instant: compiles in-memory to JS, V8 JITs it
node src/cli.js run   examples/tour.cnd --native # build with clang -O2 and run
node src/cli.js test  examples/tour.cnd          # run every `example` clause
node src/cli.js build examples/tour.cnd -o tour  # native binary (refuses if holes remain)
tests/difftest.sh                                # both backends must agree byte-for-byte
```

Requires Node ≥ 18 and a C compiler (`cc`). No dependencies.

## A taste

```
fn clamp(x: Int, lo: Int, hi: Int) -> Int
  requires lo <= hi
  ensures lo <= result and result <= hi
  example clamp(15, 0, 10) == 10
  if x < lo then
    return lo
  else if x > hi then
    return hi
  end if
  return x
end fn clamp
```

## Language reference (v0)

**Types:** `Int` (integer in ±(2⁵³−1); overflow traps), `Float` (IEEE double), `Bool`, `Str` (immutable UTF-8), `Unit`, arrays `[T]`, records, enums.

```
type Point = record          type Shape = enum
  x: Float                     Circle(center: Point, radius: Float)
  y: Float                     Empty
end type Point               end type Shape
```

**Constants:** `let NAME: Type = expr` at top level. The type is required. Initializers may use literals, operators, earlier constants and pure built-ins, but not function calls, so initialization order is always sound (using a later constant is a `const-order` error). Constants are immutable and can't be shadowed.

**Functions:** every parameter is annotated, and `-> T` is omitted for Unit. A parameter marked `inout` mutates the caller's variable: `fn advance(inout p: Parser)`, called as `advance(inout p)`. The argument must be a `var` place, and one call can't pass the same variable as `inout` twice. Header clauses come in any order before the body: `requires e`, `ensures e` (`result` is in scope), `example e`, `effects a, b`. Contracts and examples must be pure.

**Statements:** `let` (immutable), `var` (mutable), assignment to `var` places (`x = …`, `a[i] = …`, `p.f = …`), `if c then … else if … else … end if`, `while c do … end while`, `for i in a ..< b do … end for`, `for x in xs do … end for`, `match e` / `case V(a, b)` / `case _` / `end match` (must be exhaustive), `return`, `break`, `continue`.

**Expressions:** `+ - * / %` (same-type operands only; Int `/` truncates), `== !=` on Int/Float/Bool/Str and payload-free enums, `< <= > >=` on numbers, `and or not`, `++` string concatenation, `Rec { f: v }`, `[a, b]`, `Variant(args)`, `?hole`.

**Built-ins:** `print(Str)` [io], `eprint(Str)` [io], `show(Int|Float|Bool|Str|payload-free enum)` (an enum shows its variant name), `len([T]|Str)` (bytes), `push(var_array, x)`, `pop(var_array)` (removes and returns the last element; traps if empty), `array(n, fill)`, `to_float`, `to_int` (truncates; traps on out of range), `sqrt`, `assert(Bool)`, `byte_at(s, i)`, `slice(s, a, b)` (byte offsets), `from_byte(n)`, `join(parts, sep)`, `parse_float(s)`, `args()` [io], `exit(code)` [io], `read_file(path)` [fs], `write_file(path, text)` [fs], `file_exists(path)` [fs], `clock_ms()` [time].

**Effects:** `io`, `fs`, `time`. Calling something with an effect requires declaring it.

**Modules:** `use "path.cnd"` at top level, with the path relative to the file containing it. Each file loads once, and cycles are allowed. Names stay globally unique across the program, and a file can only *name* things declared in itself or in a file it directly `use`s (a `not-imported` error gives the `use` to add). Diagnostics, holes and traps name the real file.

**Copying (value semantics without paying for it everywhere):**
- Ordinary arguments are *borrowed*: passing even a huge `var` array costs nothing, because the callee can't mutate it.
- A value that *escapes* (stored in a `var`, pushed, put in a literal, or returned) is copied, unless it is fresh (a literal or a call result).
- Reading a whole `var` in any other value position, like `let b = a`, copies it. Returning a local `var` never copies.

## Architecture

```
src/lexer.js   tokens; newline = statement end (except after operators / inside brackets)
src/parser.js  AST; labeled `end` checking
src/check.js   types, effects, mutability, exhaustiveness, holes, copy analysis
src/jsgen.js   -> JavaScript (dev path, no build step)
src/cgen.js    -> C11 + GNU statement expressions (left-to-right evaluation is pinned)
src/loader.js  follows `use`, parses each file once, merges declarations dependencies-first
src/cli.js     check / run / test / build
runtime/candor_rt.h   C runtime shared by both native compilers
selfhost/      candorc: the compiler again, written in Candor, as real modules (see below)
```

Both backends share one checked AST, and `tests/difftest.sh` holds them to identical stdout, stderr and exit codes. Float printing uses a shared shortest-round-trip algorithm, so `show(0.1 + 0.2)` matches everywhere.

## Self-hosting

`selfhost/candorc.cnd` is a complete Candor compiler (lexer, parser, checker with every diagnostic, C backend) written in Candor: about 4,200 lines across six modules (`util`, `lexer`, `parser`, `check`, `cgen` and the `candorc` driver), connected by `use`.

```sh
selfhost/test.sh          # stage1 = JS compiler builds candorc; then compares candorc against the JS compiler
FULL=1 selfhost/test.sh   # ...including every benchmark
```

The test checks that:
1. every program in `tests/run`, `examples` and `bench` gives identical stdout, stderr and exit code when compiled by candorc and when run by the JS compiler;
2. every file in `tests/errors` gets **word-for-word identical** diagnostics from both compilers (46 errors in `many.cnd` alone);
3. **the bootstrap reaches a fixed point**: candorc built by the JS compiler compiles candorc (stage 2), which compiles candorc (stage 3), which compiles candorc (stage 4). The C from stages 2, 3 and 4 is byte-identical.

The self-built compiler compiles its own source in about 10 ms. What it was like to write is in [`selfhost/NOTES.md`](selfhost/NOTES.md).

## Benchmarks (Apple Silicon, best of 3)

`node bench/run.js` (or `npm run bench`) builds each `bench/*.cnd`, times both backends, checks that their outputs match byte-for-byte, and reports native peak memory. Pass names to run a subset, `-n 5` for more reps, or `--markdown` for this table.

| program | what it stresses | `run` (JS, no build) | `build` (native) | native peak RSS |
|---|---|---|---|---|
| fib(40) recursive | calls, Int overflow checks | 0.62s | 0.23s | 2 MB |
| n-body 60 bodies × 30k steps | Float math, record arrays | 0.35s | 0.10s | 240 MB |
| sieve 20M × 10 | big Bool arrays, bounds checks | 2.03s | 0.46s | 193 MB |
| collatz, longest chain < 2M | tight Int `%` `/` `*` loops | 3.65s | 0.28s | 2 MB |
| matmul 500×500 | nested `[[Float]]` indexing | 1.26s | 0.09s | 12 MB |
| heapsort 2M Ints | index-heavy compare/swap | 0.43s | 0.16s | 34 MB |
| vm, 10M-iteration bytecode loop | enum dispatch via `match` | 0.88s | 0.17s | 2 MB |
| binary trees, depth 4..16 | enum allocation + walk | 0.18s | 0.08s | 453 MB |
| strings, 1M built lines | `++`, `show(Int/Float)` | 0.38s | **1.91s** | 203 MB |

Native fib(40) is 0.24s vs 0.15s for hand-written C without overflow checks. A native build takes about 0.15s.

What the numbers show:
- **Native `show(Float)` is slow.** It finds the shortest round-trip form by trying all 17 precisions with `snprintf` + `strtod`, about 2µs a call. Int `show` is fine (1M strings in 0.4s). A binary search over precision, or a Ryu-style printer, would fix it.
- **Memory grows with allocation, not with live data**, because nothing is freed (see below): binary trees peaks at 453 MB while never holding more than ~260k live nodes, and n-body reaches 240 MB with only 60 bodies alive at a time.
- The JS backend is weakest on Int-heavy loops (collatz is 13× slower than native), most likely the cost of overflow checks on doubles.

## Known limits of v0 (honest list)

- **No memory reclamation in native builds.** A bump allocator never frees, which is fine for batch programs (candorc self-compiles in 36 MB) and bad for long-running ones.
- Escaping copies are still eager deep copies. `let b = a` on a big `var` array costs O(n).
- No generics or first-class functions yet. Writing candorc showed these are the next priorities (see `selfhost/NOTES.md`).
- Deep recursion: JS reports `trap: stack overflow`, while native crashes with a signal.
