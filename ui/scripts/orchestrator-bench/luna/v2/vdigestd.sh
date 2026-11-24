#!/bin/sh
# vdigestd.sh [already seen...]: print each finished v2 run's digest once, whenever the hidden folder is unlocked
H=/Users/yufan/Desktop/Development/provenance-wt-bench-luna/.bench-hidden
B=/private/tmp/claude-501/-Users-yufan/9e37ff0b-60f0-4144-b9a3-f4cc70335caf/scratchpad/bench-luna-v2
seen=" $* "
while [ ! -e $B/DIGEST-STOP ]; do
  for d in $(ls $H/runs-v2 2>/dev/null); do
    case "$seen" in *" $d "*) continue;; esac
    if out=$(python3 -I $B/harness/vdigest.py $H/runs-v2/$d 2>/dev/null); then seen="$seen$d "; echo "=== $d"; echo "$out" | cut -c1-1000; fi
  done
  sleep 0.1
done
