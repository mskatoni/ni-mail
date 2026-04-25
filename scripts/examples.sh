#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
AUTH_KEY="${AUTH_KEY:-replace-me}"
MAILBOX="${MAILBOX:-hello@example.com}"
RUN_SEND="${RUN_SEND:-0}"
ENCODED_MAILBOX="$(node -e "console.log(encodeURIComponent(process.env.MAILBOX || 'hello@example.com'))")"

curl_json() {
  curl -sS \
    -H "X-Auth-Key: ${AUTH_KEY}" \
    -H "Content-Type: application/json" \
    "$@"
}

echo "== health =="
curl -sS "${BASE_URL}/health"
echo

echo "== list latest =="
curl -sS -H "X-Auth-Key: ${AUTH_KEY}" "${BASE_URL}/latest?mailbox=${MAILBOX}"
echo

echo "== threaded inbox =="
curl -sS -H "X-Auth-Key: ${AUTH_KEY}" "${BASE_URL}/api/mailboxes/${ENCODED_MAILBOX}/emails?folder=inbox&threaded=true&limit=10"
echo

echo "== send =="
if [ "${RUN_SEND}" = "1" ]; then
  curl_json -X POST "${BASE_URL}/api/mailboxes/${ENCODED_MAILBOX}/send" \
    --data '{
      "to": ["user@example.net"],
      "subject": "hello from ni-mail",
      "text": "test body"
    }'
  echo
else
  echo "skipped; set RUN_SEND=1 to exercise the optional EMAIL binding"
fi
