#!/bin/sh
# poll.sh: block up to ~170 s for a new result line; print it (or one dot line)
B=/private/tmp/claude-501/-Users-yufan/9e37ff0b-60f0-4144-b9a3-f4cc70335caf/scratchpad/bench-luna
P=': (PASS|FAIL) |budget|REVIEW|done|STOP|suspicious: [1-9]|COULD NOT|INVALID|WAIT|signed out'
c0=$(cat $B/.pollcount 2>/dev/null || echo 0); n=0
while [ "$(grep -cE "$P" $B/driver.log)" = "$c0" ] && [ $n -lt 34 ] && pgrep -f bench-luna/harness/driver.py >/dev/null; do sleep 5; n=$((n+1)); done
c1=$(grep -cE "$P" $B/driver.log); echo $c1 > $B/.pollcount
if [ "$c1" != "$c0" ]; then grep -E "$P" $B/driver.log | tail -$((c1-c0)) | cut -c1-520; else echo "$(date +%H:%M) $(tail -1 $B/driver.log | cut -c10-60)"; fi
pgrep -f bench-luna/harness/driver.py >/dev/null || echo "DRIVER NOT RUNNING"
