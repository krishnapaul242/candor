#!/bin/sh
# The model-facing spec must not rot: every complete program in docs/llms.txt
# (a code block that starts with `fn`, `type`, `let NAME:` or `use`) must type-check.
cd "$(dirname "$0")/.." || exit 1
dir=$(mktemp -d); trap 'rm -rf "$dir"' EXIT
node -e '
const fs = require("fs");
const s = fs.readFileSync("docs/llms.txt", "utf8");
let i = 0;
for (const m of s.matchAll(/```\n([\s\S]*?)```/g)) {
  const b = m[1];
  if (/^(fn |type |let [A-Z_]+: )/.test(b) && !/^use /m.test(b)) fs.writeFileSync(`${process.argv[1]}/block${i++}.cnd`, b);
}' "$dir"
pass=0; fail=0
for f in "$dir"/*.cnd; do
  if node src/cli.js check "$f" >/dev/null 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: spec block"; cat "$f"; node src/cli.js check "$f"; fi
done
echo "spec: $pass blocks check, $fail fail"
[ $fail = 0 ]
