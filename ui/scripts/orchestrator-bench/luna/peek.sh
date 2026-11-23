#!/bin/sh
# peek.sh <run name> [width] [items]: retry until the hidden folder is unlocked (between runs) and the summary succeeds
H=/Users/yufan/Desktop/Development/provenance-wt-bench-luna/.bench-hidden
B=/private/tmp/claude-501/-Users-yufan/9e37ff0b-60f0-4144-b9a3-f4cc70335caf/scratchpad/bench-luna
n=0; until out=$(python3 -I $B/harness/summ.py $H/runs/$1 ${2:-200} ${3:-40} 2>/dev/null); do sleep 0.4; n=$((n+1)); [ $n -gt 4000 ] && { echo "gave up"; exit 1; }; done
echo "$out"
