#!/bin/sh
# start.sh: (re)start the Luna driver; arms in the fixed order. Pending reruns of an earlier arm come first.
L=/private/tmp/claude-501/-Users-yufan/9e37ff0b-60f0-4144-b9a3-f4cc70335caf/scratchpad/bench-luna
pgrep -f bench-luna/harness/driver.py >/dev/null && { echo "already running"; exit 1; }
BENCH_UI=/Users/yufan/Desktop/Development/provenance-wt-bench-luna/ui BENCH_HIDDEN=/Users/yufan/Desktop/Development/provenance-wt-bench-luna/.bench-hidden BENCH_MODEL=chatgpt-web/luna BENCH_SERVED_BY=chatgpt-web/luna BENCH_CALL_BUDGET=900 BENCH_HOURS=30 BENCH_REQUIRE_AC=1 nohup python3 -I $L/harness/driver.py stock,experimental,hyperexperimental >> $L/driver.out 2>&1 &
