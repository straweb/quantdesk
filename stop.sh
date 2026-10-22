#!/usr/bin/env bash
# ============================================================
# Multi-Broker Trading Terminal — stop everything
#
#   ./stop.sh              stop terminal (:3000) + feed (:3003/:3004)
#   ./stop.sh --keep-build internal flag used by start.sh (quiet)
#
# Kills the PIDs recorded by start.sh, then frees the ports as a
# fallback (catches `npm run dev` / orphaned feed processes too).
# ============================================================
set -u
cd "$(dirname "$0")"

QUIET=0
[ "${1:-}" = "--keep-build" ] && QUIET=1

STOPPED=0

# ---- 1. recorded PIDs (terminal FIRST so its feed watchdog dies with it) ----
for name in terminal feed; do
  pf="logs/$name.pid"
  if [ -f "$pf" ]; then
    pid="$(cat "$pf" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      STOPPED=1
      [ "$QUIET" = "0" ] && echo "[stop] stopped $name (pid $pid)"
    fi
    rm -f "$pf"
  fi
done

# give them a moment, then force-kill survivors
sleep 1
for name in terminal feed; do
  pf="logs/$name.pid"
  pid="$(cat "$pf" 2>/dev/null || true)"
  [ -z "$pid" ] && continue
  kill -9 "$pid" 2>/dev/null || true
done

# ---- 2. port fallback — orphans not started by start.sh ----
kill_port() {
  local port="$1" pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    fuser -k "$port/tcp" >/dev/null 2>&1 && STOPPED=1
    [ "$QUIET" = "0" ] && fuser "$port/tcp" >/dev/null 2>&1 && echo "[stop] freed :$port"
    return
  fi
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
    sleep 1
    kill -9 $pids 2>/dev/null || true
    STOPPED=1
    [ "$QUIET" = "0" ] && echo "[stop] freed :$port"
  fi
}
kill_port 3000
kill_port 3003
kill_port 3004

if [ "$QUIET" = "0" ]; then
  if [ "$STOPPED" = "1" ]; then
    echo "[stop] all services stopped"
  else
    echo "[stop] nothing was running"
  fi
fi
exit 0
