#!/usr/bin/env bash
# ============================================================
# Multi-Broker Trading Terminal — BUILD + RUN (one command)
#
#   ./start.sh                install (if needed) + prisma setup +
#                             next build + start terminal :3000 and
#                             market feed :3003/:3004
#   ./start.sh --skip-build   start from the last build (no rebuild)
#   ./start.sh --dev          dev mode (next dev) instead of build
#
# Logs → logs/terminal.log, logs/feed.log   Stop → ./stop.sh
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR" "$ROOT/db"

SKIP_BUILD=0; DEV=0
case "${1:-}" in
  --skip-build) SKIP_BUILD=1 ;;
  --dev)        DEV=1 ;;
  "")           ;;
  *) echo "usage: $0 [--skip-build|--dev]"; exit 1 ;;
esac

# ---------- 1. environment (.env auto-created on fresh clones) ----------
if [ ! -f .env ]; then
  cp .env.example .env
  # pin DATABASE_URL to THIS machine's absolute path
  if sed --version >/dev/null 2>&1; then
    sed -i "s|^DATABASE_URL=.*|DATABASE_URL=file:$ROOT/db/custom.db|" .env
  else
    sed -i '' "s|^DATABASE_URL=.*|DATABASE_URL=file:$ROOT/db/custom.db|" .env
  fi
  echo "[start] created .env from .env.example (DATABASE_URL → $ROOT/db/custom.db)"
  echo "[start] NOTE: change TERMINAL_SECRET in .env before real production use"
fi

# ---------- 2. dependencies + prisma client/schema ----------
if [ ! -d node_modules ]; then
  echo "[start] installing dependencies (first run — a few minutes)…"
  if command -v bun >/dev/null 2>&1; then bun install; else npm install; fi
fi
echo "[start] prisma generate + db push…"
npx --no-install prisma generate >/dev/null 2>&1 || npx prisma generate
npx --no-install prisma db push --accept-data-loss >/dev/null

# ---------- 3. stop leftovers from a previous run ----------
bash "$ROOT/stop.sh" --keep-build >/dev/null 2>&1 || true

# ---------- 4. market feed mini-service ----------
start_feed() {
  if command -v bun >/dev/null 2>&1; then
    (cd "$ROOT/mini-services/market-feed" \
      && PORT=3003 REST_PORT=3004 nohup bun index.ts > "$LOG_DIR/feed.log" 2>&1 \
      & echo $! > "$LOG_DIR/feed.pid")
    echo "[start] market feed  → ws :3003 · rest :3004   (logs/feed.log)"
  else
    echo "[start] WARN: bun not found — market feed NOT started (no live ticks)."
    echo "        install bun:  curl -fsSL https://bun.sh/install | bash"
  fi
}

# ---------- 5. terminal (Next.js) ----------
if [ "$DEV" = "1" ]; then
  start_feed
  echo "[start] dev server   → http://localhost:3000   (logs/terminal.log)"
  nohup npx next dev -p 3000 > "$LOG_DIR/terminal.log" 2>&1 &
  echo $! > "$LOG_DIR/terminal.pid"
else
  if [ "$SKIP_BUILD" = "0" ]; then
    echo "[start] building (next build)…"
    npm run build
  fi
  start_feed
  RUNNER="node"; command -v bun >/dev/null 2>&1 && RUNNER="bun"
  echo "[start] terminal     → http://localhost:3000   ($RUNNER standalone · logs/terminal.log)"
  (cd "$ROOT" && PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production \
    nohup $RUNNER .next/standalone/server.js > "$LOG_DIR/terminal.log" 2>&1 \
    & echo $! > "$LOG_DIR/terminal.pid")
fi

# ---------- 6. health wait ----------
printf "[start] waiting for terminal "
OK=0
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null --max-time 2 http://localhost:3000/api/auth/me 2>/dev/null; then OK=1; break; fi
  printf "."; sleep 1
done
echo
if [ "$OK" = "1" ]; then
  echo "[start] READY — open http://localhost:3000  (login: admin / admin123)"
  echo "[start] production entry: Caddy :81 → :3000 (see Caddyfile) · feed ws via /?XTransformPort=3003"
else
  echo "[start] ERROR — terminal not healthy after 60s. Check logs/terminal.log"
  tail -n 30 "$LOG_DIR/terminal.log" 2>/dev/null || true
  exit 1
fi
