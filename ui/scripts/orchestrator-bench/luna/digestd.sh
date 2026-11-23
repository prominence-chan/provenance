#!/bin/sh
# digestd.sh: whenever the hidden folder is unlocked (between runs), print the summary of each finished run once
H=/Users/yufan/Desktop/Development/provenance-wt-bench-luna/.bench-hidden
B=/private/tmp/claude-501/-Users-yufan/9e37ff0b-60f0-4144-b9a3-f4cc70335caf/scratchpad/bench-luna
seen=" $* "
while pgrep -f bench-luna/harness/ >/dev/null; do
  for d in $(ls $H/runs 2>/dev/null); do
    case "$seen" in *" $d "*) continue;; esac
    if out=$(python3 -I $B/harness/summ.py $H/runs/$d 330 36 2>/dev/null); then seen="$seen$d "; echo "=== $d"; echo "$out" | cut -c1-700; fi
  done
  sleep 0.1
done
