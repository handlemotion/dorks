#!/usr/bin/env bash
# Starts the whole local stack in the background so an agent (or a person) can test against running servers with one command,
# without holding a terminal per server. Each server runs detached with its log in $DORKS_DEV_DIR (default /tmp/dorks-dev).
#
#   scripts/dev-up.sh [up]        backend (scripts/dev-backend.sh), mail catcher, web, box simulator; waits until healthy
#   scripts/dev-up.sh status      what is running and healthy; exit 0 only if everything is
#   scripts/dev-up.sh wait        block until healthy (for a start kicked off in the background, e.g. by cloud-setup.sh --servers)
#   scripts/dev-up.sh down        stop mail, web and sim (the Convex container keeps running; `docker stop convex-local` stops it)
#   scripts/dev-up.sh logs NAME   tail a server's log (mail, web, sim, backend)
#
# Idempotent: servers already healthy are left alone. Needs what dev-backend.sh needs (Docker, Doppler CLI + DOPPLER_TOKEN).
# Prints no secret values.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DIR="${DORKS_DEV_DIR:-/tmp/dorks-dev}"
mkdir -p "$DIR"
CONVEX=http://127.0.0.1:3210
WEB=http://localhost:3000
MAIL=http://127.0.0.1:8899
log() { echo "[dev-up] $*"; }

# name -> command (run from the repo root under the Doppler dev env)
cmd_for() {
  case "$1" in
    mail) echo "node apps/convex/scripts/dev-mail.mjs" ;;
    web) echo "doppler run -p dorks -c dev -- pnpm --filter @dorks/web dev:direct --host 0.0.0.0" ;;
    sim) echo "doppler run -p dorks -c dev -- env CONVEX_URL=$CONVEX node infra/bridge-sim/host.mjs" ;;
  esac
}
SERVERS="mail web sim"

pid_of() { cat "$DIR/$1.pid" 2>/dev/null; }
alive() { local p; p="$(pid_of "$1")"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }
# The mail catcher answers any path once it listens; vite answers / with 200; the sim has no port, so it is healthy while alive.
healthy() {
  case "$1" in
    backend) curl -sf "$CONVEX/version" >/dev/null ;;
    mail) alive mail && curl -s -o /dev/null "$MAIL/" ;;
    web) curl -sf -o /dev/null "$WEB/" ;;
    sim) alive sim ;;
  esac
}

start() {
  local name="$1"
  if healthy "$name"; then log "$name already running"; return 0; fi
  alive "$name" && kill -- "-$(pid_of "$name")" 2>/dev/null
  log "starting $name (log: $DIR/$name.log)"
  # setsid: own process group, so `down` stops the server and its children (doppler -> pnpm -> vite) together.
  setsid nohup bash -c "exec $(cmd_for "$name")" >"$DIR/$name.log" 2>&1 </dev/null &
  echo $! >"$DIR/$name.pid"
}

wait_healthy() {
  local name="$1" secs="$2"
  for _ in $(seq "$secs"); do
    healthy "$name" && return 0
    [ "$name" != backend ] && ! alive "$name" && break
    sleep 1
  done
  healthy "$name"
}

status() {
  local ok=0 s
  for name in backend $SERVERS; do
    if healthy "$name"; then s=up; else s=DOWN; ok=1; fi
    printf '[dev-up] %-8s %s\n' "$name" "$s"
  done
  log "convex $CONVEX (site http://127.0.0.1:3211) | web $WEB | mail $MAIL | logs $DIR"
  return "$ok"
}

up() {
  local status=0
  echo $$ >"$DIR/up.pid"
  trap 'rm -f "$DIR/up.pid"' EXIT
  if healthy backend; then log "backend already running"
  else bash scripts/dev-backend.sh >"$DIR/backend.log" 2>&1 || { log "backend failed, last lines of $DIR/backend.log:"; tail -15 "$DIR/backend.log" | sed 's/^/    /'; status=1; }
  fi
  start mail
  start web
  if healthy backend; then start sim; else log "skipping sim: it needs the backend"; fi
  for name in $SERVERS; do
    [ "$name" = sim ] && ! healthy backend && continue
    wait_healthy "$name" 90 || { log "$name did not become healthy, last lines of $DIR/$name.log:"; tail -15 "$DIR/$name.log" | sed 's/^/    /'; status=1; }
  done
  status
  [ "$status" = 0 ] && log "ready; sign-in codes appear in $DIR/mail.log" || log "started with errors"
  return "$status"
}

down() {
  for name in $SERVERS; do
    if alive "$name"; then kill -- "-$(pid_of "$name")" 2>/dev/null && log "stopped $name"; fi
    rm -f "$DIR/$name.pid"
  done
}

case "${1:-up}" in
  up) up ;;
  status) status ;;
  wait)
    # Wait for a start in progress (e.g. the background one from cloud-setup.sh --servers) to finish, then report.
    p="$(cat "$DIR/up.pid" 2>/dev/null)"
    [ -n "$p" ] && kill -0 "$p" 2>/dev/null && log "waiting for the start in progress (log: $DIR/up.log)"
    while [ -n "$p" ] && kill -0 "$p" 2>/dev/null; do sleep 1; done
    status ;;
  down) down ;;
  logs) tail -n 50 -f "$DIR/${2:?usage: dev-up.sh logs mail|web|sim|backend}.log" ;;
  *) echo "usage: $0 [up|status|wait|down|logs NAME]" >&2; exit 2 ;;
esac
