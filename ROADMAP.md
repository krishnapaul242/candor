# Candor roadmap

The full roadmap, with what "done" means for each milestone, is at **https://krishnapaul.in/candor/roadmap.html**. The order comes from what hurt while writing Candor's own compiler in Candor (see [`selfhost/NOTES.md`](selfhost/NOTES.md)).

**Ground rules:** every change lands in both compilers (`src/` and `selfhost/`), both stay byte-identical on every test, the bootstrap keeps its fixed point, and each new rule comes with a diagnostic that says what to change.

| Milestone | Status | Summary |
|---|---|---|
| v0.1 Core language | done | effects, typed holes, contracts, labeled ends, trapping arithmetic, value semantics, JS and C backends |
| v0.2 Self-hosting | done | `inout`, borrowed arguments, `candorc` bootstraps to a fixed point; enum `==`/`show`, constants, `pop` |
| v0.3 Modules | done | `use "file.cnd"` with direct visibility; candorc is six modules; diagnostics and traps cite real files |
| v0.4 Distinct types | **next** | `type TyId = distinct Int`, so ids can't be mixed up |
| v0.5 Generics | planned | `Option[T]`, `Result[T, E]`, visible error propagation; remove the parser's `failed` flag |
| v0.6 Memory | planned | reference counting and copy-on-write; binary-trees under 50 MB (453 MB today) |
| v0.7 Typed AST | planned | per-category node types in `candorc`, exhaustive dispatch |

Parallel tracks: an evaluation of how well models write Candor (the core research question), tooling (`fmt`, a language server, an error-code index), performance (Ryu float printing), a small standard library, and eventually a JS backend for `candorc` so the self-hosted compiler can run in the browser as a playground.
