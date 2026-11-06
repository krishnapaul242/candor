# Can models write Candor? Evaluation, round 1

Candor exists for code written by models. So the measure of success is whether a model that has never seen it writes correct Candor from the reference alone.

## Method

- **Reference:** [`docs/llms.txt`](../docs/llms.txt), a single dense spec meant for a model's context window. It's the only thing participants read.
- **Tasks:** [`TASKS.md`](TASKS.md). There are nine, each chosen to touch something Candor-specific: payload enums and `match`, `inout` records, `requires` contracts, `effects`, byte-level strings, nested arrays, binary search, and an Option-style enum.
- **Isolation:** each model ran as a fresh agent in a scratch folder holding only `llms.txt` and `TASKS.md`. It had no access to the repository, no reference solutions and **no compiler**, so this measures first-attempt correctness.
- **Scoring:** [`score.sh`](score.sh). For each task it records `candor check` error codes, runs a hidden test driver ([`tests/`](tests)) that `use`s the solution and compares stdout to [`expected/`](expected), and, for the two contract tasks, checks that the required `requires` exists by confirming that a bad call traps with `requires failed`.
- **Scorer validation:** the reference solutions score 9/9. A copy with four planted bugs (wrong output, wrong sentinel, a deleted contract, a syntax error) scores 5/9, and each bug is caught.

## Results

| model | compiled first time | hidden tests passed |
|---|---|---|
| Claude (large, same family as the designer) | 9 / 9 | **9 / 9** |
| Claude Haiku (small) | 9 / 9 | **9 / 9** |

Neither model hit a single compile error, and the examples they wrote themselves all pass under `candor test`.

## What this does and doesn't show

- **These tasks are too easy to tell the models apart.** Both scored 100%, so the test can't show *where* models struggle, and the planned second phase (repairing failures using only compiler diagnostics) had nothing to repair. Round 2 needs harder tasks.
- **Both participants are Claude models,** the same family that designed Candor, so they may share its intuitions. Round 2 should include other model families.
- **Nine tasks is a small sample.**

## The useful signal: the reference had gaps, and models paid for them

Each participant was asked to list everything in `llms.txt` that was unclear. Working independently, both raised the same questions:

- Do `and` / `or` short-circuit?
- Is each `case` arm its own scope?
- Does `[]` take its type from a parameter or return type?
- Are nested writes like `grid[i][j] = v` allowed?
- Can an `inout` record's fields be assigned?
- Can `match` sit inside a loop, and can a `case` contain any statements?

The answer to every one is yes. The gaps didn't cause bugs, but they did cost something: **both models wrote defensive code** because of them. They nested `if`s instead of relying on short-circuiting, picked different names in every `case` arm, declared typed temporaries instead of returning `[]`, and avoided nested writes. That's an *uncertainty tax*: code that's longer and harder to review than it needs to be.

**Fix:** `llms.txt` now has a "Precise semantics" section that answers each question directly, and `tests/spec.sh` type-checks every complete program in the spec, so it can't go stale. That test immediately caught a broken example in the Records section that showed statements at the top level of a file.

## Reproduce

```sh
eval/score.sh eval/reference        # 9/9 sanity check
eval/score.sh eval/attempts/opus
eval/score.sh eval/attempts/haiku
```

## Local models (Ollama)

`eval/run_local.mjs` drives any Ollama model through the same tasks, and adds the **repair loop**. If an attempt doesn't compile, the model gets back *only* the compiler's diagnostics and is asked for a corrected file, up to `--rounds` times. Each round is saved as `<task>.rN.cnd`, and the error codes from every round go to `eval/results/<model>.json`.

```sh
brew install ollama && ollama serve &          # once
ollama pull qwen2.5-coder:7b                     # ~4.7 GB; :1.5b is ~1 GB
node eval/run_local.mjs qwen2.5-coder:7b --rounds 3
eval/score.sh eval/attempts/qwen2.5-coder_7b
```

Runs use temperature 0, a fixed seed and a 16k context (`llms.txt` alone is about 8k tokens), so they're reproducible on the same model build.

## Round 1b: a local model from another family (Qwen2.5-Coder, via Ollama)

These models were trained outside Anthropic and were not part of Candor's design. They ran on a laptop (Apple M5, 16 GB) with the repair loop on. Each run was repeated after changes to the compiler, so the effect of each change is visible.

| Run | What changed | 7B: compiled first try | 7B: never compiled | 7B: hidden tests | 1.5B: hidden tests |
|---|---|---|---|---|---|
| **v1** (`*.before`) | baseline | 7/9 | 1 (csv) | 6/9 | 1/9 |
| **v2** (`*.v2`) | structural `==` on arrays and records; hints for code fences, string indexing and redefining built-ins | 8/9 | 0 | 6/9 | 0/9 |
| **v3** (current) | repair loop also runs the model's **own** `example` clauses; slice hint; long lines trimmed in diagnostics | 8/9 | 0 | **7/9** | 0/9 |

What each step showed:
- **A diagnostic that wasn't an edit failed.** In v1 the 7B model wrote `example parse_csv_ints("12,-3,40") == [12, -3, 40]`. Candor had no `==` on arrays, and the hint said *"compare the fields you care about"*. The model resubmitted the same line through all 3 repair rounds. Writing `f(x) == [..]` in a test is about the most natural thing a model does, so the language changed: `==` is now structural on arrays and records. In v2, csv compiled on the first try.
- **Diagnostics that were edits worked.** `effect-missing` ("add `effects io` to the header of fn …") was fixed in one round every time. So was `can only index arrays, not Str`.
- **Models can check themselves with their own examples.** Once csv compiled, its bug (`""` gave `[0]`) was still there, and the model's own example `parse_csv_ints("") == []` stated the right answer. v3 feeds failing examples back (`candor test` output, nothing hidden), and the model fixed csv in one round. Hidden tests went from 6/9 to 7/9.
- **What's left is misreading the task:** an unwanted `requires` on `withdraw`, and a changed `summarize` signature. The model's own examples encode the same misreading, so no self-check can catch it.
- **1.5B is below the floor.** It doesn't follow the task (fizzbuzz files full of `topword_*` helpers), loops until the token cap, copies spec patterns onto built-in names (`type Int = distinct Int`), and ignores hints that state the exact fix. Diagnostics can't rescue a model that can't follow instructions. Its failures still produced three compiler improvements that help every model: the code-fence hint, the slice-syntax hint, and trimming 11,000-character lines out of diagnostics.

Reproduce: `node eval/run_local.mjs qwen2.5-coder:7b --rounds 3`, then `eval/score.sh eval/attempts/qwen2.5-coder_7b` and `node eval/compare.mjs eval/results/*.json`.

## Next round

1. Harder tasks: multi-file programs with `use`, programs of 150+ lines, distinct-type ids, holes, and tasks where the obvious solution is subtly wrong.
2. More model families and sizes. Qwen 7B and 1.5B are done; next are a 14B–32B open model, and other families such as Llama, Gemma and DeepSeek.
3. The repair loop: give each failing attempt only the compiler's `--json` diagnostics and measure how many rounds it takes to reach passing code. That tests whether the error messages work *for models*.
