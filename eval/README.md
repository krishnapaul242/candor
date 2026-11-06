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

## Next round

1. Harder tasks: multi-file programs with `use`, programs of 150+ lines, distinct-type ids, holes, and tasks where the obvious solution is subtly wrong.
2. More model families and sizes, including small open models.
3. The repair loop: give each failing attempt only the compiler's `--json` diagnostics and measure how many rounds it takes to reach passing code. That tests whether the error messages work *for models*.
