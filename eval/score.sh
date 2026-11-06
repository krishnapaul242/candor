#!/bin/sh
# Score a set of attempts: eval/score.sh <attempts-dir>   (e.g. eval/attempts/opus)
# For each task: does the attempt check cleanly (and which error codes), do the
# hidden tests print the expected output, and are required contracts present?
cd "$(dirname "$0")/.." || exit 1
DIR=$1; OUT=$(mktemp -d "${TMPDIR:-/tmp}/candor-score.XXXXXX"); trap 'rm -rf "$OUT"; rm -f eval/tests/_run_$$.cnd' EXIT
pass=0; total=0
for t in fizzbuzz top_word stack_machine bank transpose find lookup csv summary; do
  total=$((total+1)); sol=$DIR/$t.cnd
  if [ ! -f "$sol" ]; then echo "$t: MISSING"; continue; fi
  codes=$(node src/cli.js check "$sol" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -oE '^error\[[a-z-]+\]' | sed 's/error\[\(.*\)\]/\1/' | sort | uniq -c | awk '{printf "%s%s×%s", sep, $2, $1; sep=", "}')
  rel=$(python3 -c "import os,sys;print(os.path.relpath(sys.argv[1], 'eval/tests'))" "$sol")
  result="tests FAIL"
  sed "s#@SOL@#$rel#" eval/tests/$t.cnd > eval/tests/_run_$$.cnd
  if node src/cli.js run eval/tests/_run_$$.cnd > $OUT/$t.out 2>$OUT/$t.err && cmp -s $OUT/$t.out eval/expected/$t.txt; then result="tests ok"; fi
  extra=""
  if [ -f eval/tests/${t}_contract.cnd ]; then
    sed "s#@SOL@#$rel#" eval/tests/${t}_contract.cnd > eval/tests/_run_$$.cnd
    if node src/cli.js run eval/tests/_run_$$.cnd 2>&1 | grep -q "requires failed"; then extra=", contract ok"; else extra=", contract MISSING"; result="tests FAIL"; fi
  fi
  rm -f eval/tests/_run_$$.cnd
  [ "$result" = "tests ok" ] && pass=$((pass+1))
  printf "%-14s %-10s%s   check: %s\n" "$t" "$result" "$extra" "${codes:-clean}"
done
echo "$pass/$total tasks pass"
