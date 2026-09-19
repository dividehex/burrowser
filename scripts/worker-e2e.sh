#!/bin/sh
# Checks a worker image with a real Chromium in a local container, for what unit tests cannot show:
#   1. the first thumbnail, requested as the browser launches, succeeds
#   2. closing every tab leaves one usable blank tab, with no errors (repeated)
#   3. SIGTERM (what a Pod delete sends) on a live browser closes Chromium normally:
#      exit_type Normal, exited_cleanly, no stale Singleton locks
# Each check gets its own fresh container and profile. Usage: scripts/worker-e2e.sh [IMAGE]
# (default localhost:5000/burrowser-worker:dev; build it first). Needs docker, curl, openssl and node.
# The containers run with seccomp unconfined for this local check only; the cluster uses the reviewed
# profile from scripts/install-chromium-seccomp.sh.
set -eu

IMAGE=${1:-localhost:5000/burrowser-worker:dev}
PORT=${WORKER_E2E_PORT:-18090}
NAME="burrowser-worker-e2e-$$"
VOLUME="$NAME-profile"
CREDENTIAL=$(openssl rand -hex 16)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
failed=0

teardown() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true; }
trap teardown EXIT INT TERM
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; failed=1; }

boot() {
  teardown
  docker volume create "$VOLUME" >/dev/null
  docker run --rm --user 0 --entrypoint chown -v "$VOLUME":/profile "$IMAGE" 10001:10001 /profile
  docker run -d --name "$NAME" --user 10001:10001 -v "$VOLUME":/profile --shm-size=256m \
    --security-opt seccomp=unconfined --security-opt no-new-privileges --cap-drop ALL \
    -e WORKER_CONTROLLER_CREDENTIAL="$CREDENTIAL" -e BURROWSER_VNC_PASSWORD="$CREDENTIAL" \
    -e BURROWSER_AUTHENTICATOR_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')" \
    -p "127.0.0.1:$PORT:8080" "$IMAGE" >/dev/null
  for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && return 0; sleep 1; done
  echo "FAIL  the worker did not become healthy"; docker logs "$NAME" 2>&1 | tail -5; exit 1
}
thumbnail() {
  curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $CREDENTIAL" -H 'content-type: application/json' \
    -d '{"method":"thumbnail"}' "http://127.0.0.1:$PORT/rpc"
}

echo "== first thumbnail, requested as the browser launches"
boot
status=$(thumbnail)
[ "$status" = 200 ] && pass "thumbnail answered 200" || fail "thumbnail answered $status"

echo "== closing every tab"
boot
thumbnail >/dev/null || true
if node --experimental-strip-types --disable-warning=ExperimentalWarning "$ROOT/scripts/worker-e2e-tabs.ts" "$PORT" "$CREDENTIAL" 6; then
  pass "every round left one blank tab and no errors"
else fail "closing all tabs broke the browser (see rounds above)"; fi

echo "== SIGTERM on a live browser closes Chromium normally"
boot
thumbnail >/dev/null || true
sleep 6
docker exec "$NAME" sh -c 'pgrep -f chrome-linux64/chrome >/dev/null' || fail "no Chromium was running to stop"
docker stop -t 45 "$NAME" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
[ "$code" = 0 ] && pass "worker exited 0 after SIGTERM" || fail "worker exited $code after SIGTERM (137 means it was killed)"
markers=$(docker run --rm --user 10001:10001 --entrypoint sh -v "$VOLUME":/p "$IMAGE" -c \
  'grep -o "\"exit_type\":\"[A-Za-z]*\"" /p/chromium/Default/Preferences; grep -o "\"exited_cleanly\":[a-z]*" "/p/chromium/Local State"; ls /p/chromium | grep -i "^Singleton" || true')
echo "$markers" | grep -q '"exit_type":"Normal"' && pass 'exit_type is "Normal"' || fail "exit_type is not Normal ($(echo "$markers" | tr '\n' ' '))"
echo "$markers" | grep -q 'exited_cleanly":true' && pass "Local State says exited_cleanly" || fail "Local State does not say exited_cleanly"
if echo "$markers" | grep -qi '^Singleton'; then fail "stale Singleton lock files left in the profile"; else pass "no stale Singleton lock files"; fi

[ "$failed" = 0 ] && echo "worker e2e: all checks passed" || { echo "worker e2e: FAILED"; exit 1; }
