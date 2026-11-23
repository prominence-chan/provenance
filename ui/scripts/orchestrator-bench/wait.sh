#!/bin/sh
B=/private/tmp/claude-501/-Users-yufan/9e37ff0b-60f0-4144-b9a3-f4cc70335caf/scratchpad/bench
P=': (PASS|FAIL) |budget|REVIEW|done|STOP|suspicious: [1-9]|COULD NOT'
c0=$(grep -cE "$P" $B/driver.out); n=0
while [ "$(grep -cE "$P" $B/driver.out)" = "$c0" ] && [ $n -lt 33 ] && pgrep -f harness/driver.py >/dev/null; do sleep 5; n=$((n+1)); done
c1=$(grep -cE "$P" $B/driver.out)
if [ "$c1" != "$c0" ]; then grep -E "$P" $B/driver.out | tail -$((c1-c0)) | cut -c1-260; else echo "$(date +%H:%M) .. $(tail -1 $B/driver.out | cut -c10-90)"; fi
pgrep -f harness/driver.py >/dev/null || echo "DRIVER NOT RUNNING"
