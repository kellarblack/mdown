#!/usr/bin/env bash
# Run every suite and print one summary.
#
#   ./tests/run-all.sh            # everything
#   ./tests/run-all.sh backend    # just the python tests
#
# Headless Chrome must NOT get --virtual-time-budget: it freezes the clock the
# WASM engine needs and the remux/tools suites hang forever.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
REPORT=/tmp/mdown-report.json
MOCK_PORT=4320
WEB_PORT=4331
fail=0

cleanup() {
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null
  [ -n "${WEB_PID:-}" ] && kill "$WEB_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

section() { printf '\n== %s\n' "$1"; }

# ---- privacy --------------------------------------------------------------
section "privacy"
if python3 tests/privacy_check.py; then :; else fail=1; fi

# ---- backend --------------------------------------------------------------
section "backend"
out=$(cd server && python3 -m unittest discover -s tests 2>&1 | tail -3)
echo "$out"
case "$out" in *OK*) ;; *) fail=1 ;; esac

if [ "${1:-all}" = "backend" ]; then
  [ $fail -eq 0 ] && echo "all good" || echo "something failed"
  exit $fail
fi

# ---- servers --------------------------------------------------------------
python3 tests/mock-api.py "$MOCK_PORT" >/dev/null 2>&1 &
MOCK_PID=$!
python3 -m http.server "$WEB_PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
WEB_PID=$!
sleep 1.5

# suites that finish on their own POST their results to the mock
report_suite() {
  local name="$1" url="$2" expect="$3"
  rm -f "$REPORT"
  "$CHROME" --headless=new --disable-gpu --user-data-dir="/tmp/mdown-run-$$-$name" "$url" >/dev/null 2>&1 &
  local chrome=$!
  for _ in $(seq 1 45); do [ -s "$REPORT" ] && break; sleep 2; done
  kill "$chrome" 2>/dev/null
  if [ ! -s "$REPORT" ]; then
    printf '%-8s no report (timed out)\n' "$name"
    fail=1
    return
  fi
  if python3 - "$name" "$expect" <<'PY'
import json, sys
name, expect = sys.argv[1], int(sys.argv[2])
d = json.load(open("/tmp/mdown-report.json"))
total, failures = d.get("total", 0), d.get("failures", 0)
ok = failures == 0 and total == expect
print("%-8s %d/%d  %s" % (name, total - failures, total, "ok" if ok else "FAILED"))
for r in d.get("results", []):
    if not r.get("ok"):
        print("   FAIL:", r.get("name"), "-", (r.get("detail") or "")[:70])
sys.exit(0 if ok else 1)
PY
  then :; else fail=1; fi
}

# suites that only need the DOM: count PASS/FAIL lines from the rendered page
dom_suite() {
  local name="$1" url="$2" expect="$3"
  local html
  html=$("$CHROME" --headless=new --disable-gpu --user-data-dir="/tmp/mdown-dom-$$-$name" \
        --virtual-time-budget=30000 --dump-dom "$url" 2>/dev/null)
  local passes fails
  passes=$(printf '%s' "$html" | grep -o 'PASS ' | wc -l | tr -d ' ')
  fails=$(printf '%s' "$html" | grep -o 'FAIL ' | wc -l | tr -d ' ')
  if [ "$passes" = "$expect" ] && [ "$fails" = "0" ]; then
    printf '%-8s %s/%s  ok\n' "$name" "$passes" "$expect"
  else
    printf '%-8s %s/%s  FAILED (%s failures)\n' "$name" "$passes" "$expect" "$fails"
    fail=1
  fi
}

section "browser"
report_suite tools  "http://127.0.0.1:$WEB_PORT/tests/tools.test.html?report=1" 38
report_suite remux  "http://127.0.0.1:$WEB_PORT/tests/remux.test.html?report=1" 90
report_suite picker "http://127.0.0.1:$WEB_PORT/tests/picker.test.html?report=1" 13
report_suite picker2 "http://127.0.0.1:$WEB_PORT/tests/picker.test.html?report=1&w=390" 15
report_suite status "http://127.0.0.1:$WEB_PORT/tests/status.test.html?report=1" 10
report_suite large  "http://127.0.0.1:$WEB_PORT/tests/large.test.html?report=1" 8
report_suite marks  "http://127.0.0.1:$WEB_PORT/tests/services.test.html?report=1" 8
report_suite apikey "http://127.0.0.1:$WEB_PORT/tests/apikey.test.html?report=1" 8
report_suite setup  "http://127.0.0.1:$WEB_PORT/tests/setup.test.html?report=1" 8
report_suite donate "http://127.0.0.1:$WEB_PORT/tests/donate.test.html?report=1" 11

printf '\n'
[ $fail -eq 0 ] && echo "all good" || echo "something failed"
exit $fail
