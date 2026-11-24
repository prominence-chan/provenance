#!/bin/sh
# start.sh: (re)start the v2 Luna driver. Arms: Hyperexperimental, Experimental, stock. Pending reruns come first.
V=/private/tmp/claude-501/-Users-yufan/9e37ff0b-60f0-4144-b9a3-f4cc70335caf/scratchpad/bench-luna-v2
ps aux | grep "bench-luna-v2/harness/driver.py" | grep -v grep >/dev/null && { echo "already running"; exit 1; }
BENCH_UI=/Users/yufan/Desktop/Development/provenance-wt-bench-luna/ui BENCH_HIDDEN=/Users/yufan/Desktop/Development/provenance-wt-bench-luna/.bench-hidden BENCH_KEEP=runs-v2 BENCH_MODEL=chatgpt-web/luna BENCH_SERVED_BY=chatgpt-web/luna BENCH_CALL_BUDGET=750 BENCH_HOURS=12 BENCH_REQUIRE_AC= BENCH_MIN_BATTERY=15 nohup caffeinate -i python3 -I $V/harness/driver.py hyperexperimental,experimental,stock >> $V/driver.out 2>&1 &
