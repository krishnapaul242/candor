#!/bin/sh
# Runs every tests/run/*.cnd on both backends; outputs must be byte-identical.
cd "$(dirname "$0")/.." || exit 1
pass=0; fail=0
for f in tests/run/*.cnd; do
  js_out=$(node src/cli.js run "$f" 2>/tmp/candor_js_err); js_code=$?
  c_out=$(node src/cli.js run --native "$f" 2>/tmp/candor_c_err); c_code=$?
  if [ "$js_out" = "$c_out" ] && [ "$js_code" = "$c_code" ] && cmp -s /tmp/candor_js_err /tmp/candor_c_err; then
    pass=$((pass+1)); echo "ok    $f (exit $js_code)"
  else
    fail=$((fail+1)); echo "DIFF  $f"
    echo "--- js (exit $js_code)"; echo "$js_out"; cat /tmp/candor_js_err
    echo "--- c  (exit $c_code)"; echo "$c_out"; cat /tmp/candor_c_err
  fi
done
echo "$pass identical, $fail differ"
[ "$fail" = 0 ]
