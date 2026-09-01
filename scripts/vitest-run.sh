#!/usr/bin/env bash
# `pnpm test`, with one specific lie removed from its exit code.
#
# THE PROBLEM. A full run reports `Tests 2272 passed (2272)` and then exits 1,
# because a worker threw an unhandled `[vitest-worker]: Timeout calling
# "onTaskUpdate"`. That is vitest's own worker->main RPC, not our code: birpc
# gives a non-event call 60s (DEFAULT_TIMEOUT), and vitest 3.2 passes no
# override — createForksRpcOptions sets serialize/deserialize/post/on and no
# `timeout` — so it cannot be raised from config. The main process serves every
# worker's module transforms while draining their task updates, and under load
# it can be held past sixty seconds. Both slowest files (cli/test/setup.test.ts,
# the deployment stack's wiring test) exit 0 when run alone; vitest.config.ts took
# maxForks 4 -> 3 to widen the margin, which made it rarer and not impossible —
# it still fires inside the release gate, where docker and the other gates share
# the machine.
#
# WHY THIS IS NOT "IGNORING A FAILURE". Ignoring it would be `|| true`. The one
# and only shape allowed through here is: every test file passed, every test
# passed, and the count of unhandled errors EQUALS the count of that exact RPC
# message. A single unhandled error from anything else — a floating rejection
# in application code, which vitest reports through the same channel and which
# genuinely can invalidate a run — fails, as does one failed test. And nothing
# is quiet about it: the pass is announced with the reason, because a gate that
# swallows something is worse than one that fails, and both are worse than one
# that says what it saw.
set -uo pipefail
cd "$(dirname "$0")/.."

LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT

npx vitest run "$@" 2>&1 | tee "$LOG"
STATUS=${PIPESTATUS[0]}
[ "$STATUS" -eq 0 ] && exit 0

# Any failed file or test: not this case, propagate untouched.
grep -qE "^ Test Files .*failed" "$LOG" && exit "$STATUS"
grep -qE "^      Tests .*failed" "$LOG" && exit "$STATUS"
# The summary must exist at all. A crash before the summary (OOM, a worker dying
# outright) leaves no counts, and "no evidence of failure" is not evidence of
# success.
grep -qE "^ Test Files .*passed" "$LOG" || exit "$STATUS"
grep -qE "^      Tests .*passed" "$LOG" || exit "$STATUS"

CAUGHT=$(grep -oE "Vitest caught [0-9]+ unhandled error" "$LOG" | grep -oE "[0-9]+" | head -1)
RPC=$(grep -c 'Timeout calling "onTaskUpdate"' "$LOG")
[ -n "${CAUGHT:-}" ] && [ "$CAUGHT" -ge 1 ] && [ "$CAUGHT" -eq "$RPC" ] || exit "$STATUS"

echo
echo "note: vitest exited $STATUS on $CAUGHT unhandled error(s), and every one of them"
echo "      is the worker->main RPC timeout described in scripts/vitest-run.sh —"
echo "      vitest's own plumbing under load, with no test failed and no other"
echo "      unhandled error. Treating this run as the pass its summary reports."
echo "      Any other unhandled error, or any failed test, still fails here."
exit 0
