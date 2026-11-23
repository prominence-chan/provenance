#!/bin/sh
# requeue.sh <log pattern>: when the pattern appears in driver.log, ask the driver to stop after the run in progress, then restart it
L=/private/tmp/claude-501/-Users-yufan/9e37ff0b-60f0-4144-b9a3-f4cc70335caf/scratchpad/bench-luna
until grep -qE "$1" $L/driver.log; do sleep 5; done
touch $L/STOP
while pgrep -f bench-luna/harness/driver.py >/dev/null; do sleep 2; done
rm -f $L/STOP
sh $L/harness/start.sh
echo "driver restarted $(date +%H:%M:%S)"
