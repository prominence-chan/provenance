#!/bin/sh
# grab.sh <run> <regex>: at the next unlock, print lines of the run's record files that match (cut to 1200 chars)
H=/Users/yufan/Desktop/Development/provenance-wt-bench-luna/.bench-hidden
until out=$(cd $H/runs/$1/record 2>/dev/null && ls >/dev/null 2>&1 && grep -rIoE --include='*.json' --include='*.jsonl' ".{0,500}($2).{0,700}" . 2>/dev/null | head -${3:-12}); do sleep 0.1; done
echo "$out" | cut -c1-1400
