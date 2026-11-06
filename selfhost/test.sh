#!/bin/sh
# Self-hosting test: candorc (Candor-in-Candor) vs the JS reference compiler.
#   1. every tests/run program: identical stdout, stderr, exit code
#   2. every tests/errors program: identical diagnostics (code:line:col)
#   3. bootstrap fixed point: stage2 C == stage3 C
cd "$(dirname "$0")/.." || exit 1
CC="cc -std=gnu11 -O2 -ffp-contract=off -w -I runtime"
B=build; mkdir -p $B
STAGE=${CANDORC:-$B/candorc1}
if [ -z "$CANDORC" ]; then
  node src/cli.js build selfhost/candorc.cnd -o $B/candorc1 2>/dev/null || { echo "stage1 build failed"; exit 1; }
fi
pass=0; fail=0
ok() { pass=$((pass+1)); echo "ok    $1"; }
bad() { fail=$((fail+1)); echo "FAIL  $1"; }

for f in tests/run/*.cnd tests/modules/*.cnd examples/*.cnd bench/*.cnd; do
  case "$f" in bench/*) [ -n "$FULL" ] || continue;; esac
  n=$(basename "$f" .cnd)
  if ! $STAGE build "$f" $B/$n.c 2>$B/$n.cerr || ! $CC $B/$n.c -o $B/$n -lm 2>>$B/$n.cerr; then bad "$f (compile)"; cat $B/$n.cerr; continue; fi
  ./$B/$n >$B/$n.out1 2>$B/$n.err1; c1=$?
  node src/cli.js run "$f" >$B/$n.out2 2>$B/$n.err2; c2=$?
  if [ $c1 = $c2 ] && cmp -s $B/$n.out1 $B/$n.out2 && cmp -s $B/$n.err1 $B/$n.err2; then ok "$f"; else bad "$f (exit $c1 vs $c2)"; diff $B/$n.out1 $B/$n.out2 | head -5; diff $B/$n.err1 $B/$n.err2 | head -5; fi
done

for f in tests/errors/*.cnd tests/modules/errors/*.cnd; do
  a=$($STAGE check "$f" 2>&1 | grep -oE '^error\[[a-z-]+\] [^ ]+:[0-9]+:[0-9]+')
  b=$(node src/cli.js check "$f" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -oE '^error\[[a-z-]+\] [^ ]+:[0-9]+:[0-9]+')
  if [ "$a" = "$b" ]; then ok "$f (diagnostics)"; else bad "$f (diagnostics)"; echo "candorc:"; echo "$a"; echo "js:"; echo "$b"; fi
done

echo "--- bootstrap"
$STAGE build selfhost/candorc.cnd $B/stage2.c && $CC $B/stage2.c -o $B/candorc2 -lm || { bad "stage2"; exit 1; }
$B/candorc2 build selfhost/candorc.cnd $B/stage3.c && $CC $B/stage3.c -o $B/candorc3 -lm || { bad "stage3"; exit 1; }
$B/candorc3 build selfhost/candorc.cnd $B/stage4.c || { bad "stage4"; exit 1; }
if cmp -s $B/stage2.c $B/stage3.c && cmp -s $B/stage3.c $B/stage4.c; then ok "fixed point: stage2.c == stage3.c == stage4.c ($(wc -l < $B/stage3.c) lines of C)"; else bad "fixed point"; diff $B/stage2.c $B/stage3.c | head; fi
echo "$pass passed, $fail failed"
[ $fail = 0 ]
