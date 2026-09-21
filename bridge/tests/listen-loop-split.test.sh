#!/usr/bin/env bash
# listen-loop-split.test.sh — a stub bridge (no body, no dark-eye unit) hands
# `eye listen-loop` one long remote transcript; every printed line must stay under
# the Monitor's 500-char cut (measured 2026-09-14: 500 passes, 550 is truncated),
# carry the VOICE [remote] / (cont) prefixes, and reassemble to the original text.
set -euo pipefail
EYE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/eye.sh
TMP=$(mktemp -d); trap 'kill $STUB 2>/dev/null; rm -rf "$TMP"' EXIT
TEXT=$(python3 -c 'print(" ".join("palabra%03d" % i for i in range(150)))')   # 1650 chars

python3 - "$TMP" "$TEXT" > "$TMP/port" <<'PY' &
import http.server, json, sys, time
tmp, text = sys.argv[1], sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    served = False
    def do_GET(self):
        if not H.served:
            H.served = True
            body = json.dumps({"transcript": text, "source": "remote"}).encode()
        else:
            time.sleep(2); body = b"{}"
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
s = http.server.HTTPServer(("127.0.0.1", 0), H)
print(s.server_address[1], flush=True)
s.serve_forever()
PY
STUB=$!
until [ -s "$TMP/port" ]; do sleep 0.05; done
echo "{\"secret\":\"t\",\"port\":$(cat "$TMP/port")}" > "$TMP/config.json"

DARK_EYE_CONFIG=$TMP/config.json timeout 3 bash "$EYE" listen-loop > "$TMP/out" || true
grep -v '^LISTEN-LOOP DIED' "$TMP/out" > "$TMP/lines"

fail=0
n=$(wc -l < "$TMP/lines")
[ "$n" -ge 4 ] || { echo "FAIL: expected >=4 lines, got $n"; fail=1; }
awk 'length($0) > 400 { print "FAIL: line too long (" length($0) ")"; exit 1 }' "$TMP/lines" || fail=1
head -1 "$TMP/lines" | grep -q '^VOICE \[remote\]: palabra000' || { echo "FAIL: first line prefix"; fail=1; }
tail -n +2 "$TMP/lines" | grep -vq '^VOICE \[remote\] (cont): ' && { echo "FAIL: continuation prefix"; fail=1; }
joined=$(sed -e 's/^VOICE \[remote\]: //' -e 's/^VOICE \[remote\] (cont): //' "$TMP/lines" | paste -sd ' ')
[ "$joined" = "$TEXT" ] || { echo "FAIL: reassembled text differs"; fail=1; }
[ $fail -eq 0 ] && echo "ok: $n lines, longest $(awk '{ if (length($0) > m) m = length($0) } END { print m }' "$TMP/lines") chars"
exit $fail
