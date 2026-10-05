#!/bin/bash

# Palworld session runner (ported from the Minecraft run-session.sh).
# Key differences from Minecraft:
#   - Palworld has no stdin console, so commands/stop go through the built-in
#     REST API on 127.0.0.1:$REST_PORT (basic auth: admin / $ADMIN_PASSWORD).
#   - The game port is UDP, so the playit.gg tunnel must be a UDP tunnel.

git config core.fileMode false

SESSION_MINUTES=330   # leaves room for steamcmd install before, and stop+commit after
STOP_FLAG=/tmp/intentional_stop   # file flag (not a variable) so the background poller can tell the main loop "this stop was on purpose"
rm -f "$STOP_FLAG"

SERVER_PORT="${SERVER_PORT:-8211}"
REST_PORT="${REST_PORT:-8212}"
MAX_PLAYERS="${MAX_PLAYERS:-16}"
LOG_FILE="server/server-stdout.log"

push_console_state() {
  for attempt in 1 2 3; do
    if git push origin HEAD:main --quiet 2>/dev/null; then
      return 0
    fi
    git fetch origin main --quiet 2>/dev/null
    if git rebase origin/main --quiet 2>/dev/null; then
      continue
    fi
    for f in $(git diff --name-only --diff-filter=U 2>/dev/null); do
      git checkout --ours -- "$f" 2>/dev/null
      git add "$f" 2>/dev/null
    done
    GIT_EDITOR=true git rebase --continue --quiet 2>/dev/null || { git rebase --abort 2>/dev/null || true; }
  done
  echo "WARNING: could not push console state after retries (non-fatal, will retry next poll)."
  return 1
}

discord() {
  [ -n "$DISCORD_WEBHOOK" ] || return 0
  curl -s -H "Content-Type: application/json" -d "$1" "$DISCORD_WEBHOOK" > /dev/null
}

if [ -z "$PLAYIT_SECRET" ]; then
  echo "ERROR: PLAYIT_SECRET is not set. Add it as a GitHub Actions secret."
  exit 1
fi
if [ -z "$ADMIN_PASSWORD" ]; then
  echo "ERROR: ADMIN_PASSWORD is not set. Add PAL_ADMIN_PASSWORD as a GitHub Actions secret (needed for the REST API)."
  exit 1
fi
if [ -z "$TUNNEL_ADDRESS" ]; then
  echo "ERROR: No tunnel_address configured. Put it in worlds/<world>/meta.json."
  echo "Make sure that tunnel is a UDP tunnel pointed at local port $SERVER_PORT in the playit.gg dashboard."
  exit 1
fi

echo "Starting playit.gg agent via Docker..."
docker run -d --net=host \
  -e SECRET_KEY="$PLAYIT_SECRET" \
  --name playit-agent \
  ghcr.io/playit-cloud/playit-agent:1.0

sleep 5
echo "--- playit container status ---"
docker ps -a --filter "name=playit-agent"
sleep 15
echo "--- playit container logs ---"
docker logs playit-agent 2>&1 || true
echo "--- end logs ---"
echo "Using tunnel address: $TUNNEL_ADDRESS -> local UDP port $SERVER_PORT"

# ---- REST API helpers -------------------------------------------------------
api() {   # api METHOD path [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -m 30 -u "admin:$ADMIN_PASSWORD" -X "$method" \
      -H "Content-Type: application/json" -d "$body" \
      "http://127.0.0.1:$REST_PORT/v1/api/$path"
  else
    curl -s -m 30 -u "admin:$ADMIN_PASSWORD" -X "$method" \
      -H "Content-Type: application/json" \
      "http://127.0.0.1:$REST_PORT/v1/api/$path"
  fi
}

api_up() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 -u "admin:$ADMIN_PASSWORD" \
      "http://127.0.0.1:$REST_PORT/v1/api/info")" = "200" ]
}

# Console commands (sent via console/command.txt, line 1 = id, line 2 = command):
#   save | info | players | metrics
#   announce <message>
#   kick <userid> [message]     (userid looks like steam_7656119...)
#   ban <userid> [message]
#   unban <userid>
run_command() {
  local line="$1" verb arg="" first rest
  verb="${line%% *}"
  [ "$line" != "$verb" ] && arg="${line#* }"
  case "$verb" in
    save)    api POST save ;;
    info)    api GET info ;;
    players) api GET players ;;
    metrics) api GET metrics ;;
    announce)
      api POST announce "$(jq -nc --arg m "$arg" '{message:$m}')" ;;
    kick|ban)
      first="${arg%% *}"; rest=""
      [ "$arg" != "$first" ] && rest="${arg#* }"
      api POST "$verb" "$(jq -nc --arg u "$first" --arg m "$rest" '{userid:$u,message:$m}')" ;;
    unban)
      api POST unban "$(jq -nc --arg u "$arg" '{userid:$u}')" ;;
    *)
      echo "Unknown command '$verb'. Supported: save, info, players, metrics, announce, kick, ban, unban." ;;
  esac
}

# Saves via the REST API, then asks the server to shut down (which also saves),
# and waits for the process to exit. Escalates to SIGTERM / SIGKILL if needed.
graceful_stop() {
  local wait_seconds="${1:-90}"
  touch "$STOP_FLAG"
  echo "Saving world and requesting shutdown via REST API (waiting up to ${wait_seconds}s)..."
  api POST save > /dev/null 2>&1 || true
  sleep 3
  api POST shutdown '{"waittime":5,"message":"Server session ended. World saved."}' > /dev/null 2>&1 || true

  for i in $(seq 1 "$wait_seconds"); do
    kill -0 "$PAL_PID" 2>/dev/null || { echo "Server exited cleanly."; return 0; }
    sleep 1
  done

  echo "Server didn't exit after shutdown request — escalating to SIGTERM."
  pkill -TERM -f PalServer-Linux-Shipping 2>/dev/null || true
  for i in $(seq 1 20); do
    kill -0 "$PAL_PID" 2>/dev/null || { echo "Server exited after SIGTERM."; return 0; }
    sleep 1
  done

  echo "Server still alive — forcing SIGKILL. Anything since the last autosave is lost."
  pkill -KILL -f PalServer-Linux-Shipping 2>/dev/null || true
  kill -KILL "$PAL_PID" 2>/dev/null || true
}

# ---- Start the server ------------------------------------------------------
echo "Starting Palworld server..."
cd server
chmod +x PalServer.sh Pal/Binaries/Linux/PalServer-Linux-Shipping 2>/dev/null || true
EXTRA_ARGS=""
if [ "$PUBLIC_LOBBY" = "true" ]; then
  EXTRA_ARGS="-publiclobby"
  echo "Public lobby listing enabled (-publiclobby)."
fi
./PalServer.sh -port="$SERVER_PORT" -players="$MAX_PLAYERS" $EXTRA_ARGS \
  -useperfthreads -NoAsyncLoadingThread -UseMultithreadForDS >> server-stdout.log 2>&1 &
PAL_PID=$!
cd ..

mkdir -p console
echo -n "" > console/command.txt
echo -n "" > console/stop.txt
git add console/command.txt console/stop.txt
git commit -m "console: reset signal files for new session" --quiet 2>/dev/null || true
push_console_state || true

echo "Waiting for the REST API to come up (up to 5 min)..."
READY=false
for i in $(seq 1 60); do
  kill -0 "$PAL_PID" 2>/dev/null || break
  if api_up; then READY=true; break; fi
  sleep 5
done

if [ "$READY" = "true" ]; then
  echo "Server is up."
  discord "{\"content\": \"🟢 **Palworld server is UP**\\nConnect at: \`$TUNNEL_ADDRESS\`\\nSession will run for ~5h30m.\\nRun log: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID\"}"
else
  echo "::warning::Server/REST API did not come up. Check the logs artifact. Continuing so the shutdown/commit steps still run."
fi

# ---- Console poller ---------------------------------------------------------
poll_console() {
  sleep 5
  LAST_EXECUTED_ID=""
  while kill -0 "$PAL_PID" 2>/dev/null; do
    git fetch origin main --quiet
    git merge --ff-only origin/main --quiet 2>/dev/null || true

    if [ -s console/command.txt ]; then
      CMD_ID=$(sed -n '1p' console/command.txt)
      CMD=$(sed -n '2p' console/command.txt)

      if [ "$CMD_ID" != "$LAST_EXECUTED_ID" ]; then
        echo "Executing console command: $CMD"
        LAST_EXECUTED_ID="$CMD_ID"
        OUTPUT=$(run_command "$CMD" 2>&1 | tail -c 1500)
        [ -z "$OUTPUT" ] && OUTPUT="(ok)"

        echo -n "" > console/command.txt
        git add console/command.txt
        git commit -m "console: executed command" --quiet 2>/dev/null
        push_console_state || true

        PAYLOAD=$(jq -n --arg cmd "$CMD" --arg out "$OUTPUT" \
          '{content: ("📤 `" + $cmd + "`\n```\n" + $out + "\n```")}')
        discord "$PAYLOAD"
      fi
    fi

    if [ -s console/stop.txt ]; then
      echo "Graceful stop signal received — shutting down..."
      echo -n "" > console/stop.txt
      git add console/stop.txt
      git commit -m "console: stop signal consumed" --quiet
      push_console_state || true

      graceful_stop 60
      break
    fi

    sleep 5
  done
}
poll_console &
POLL_PID=$!

echo "Session running for up to $SESSION_MINUTES minutes (or until a graceful stop is triggered)..."
END_TIME=$((SECONDS + SESSION_MINUTES * 60))
while kill -0 "$PAL_PID" 2>/dev/null && [ $SECONDS -lt $END_TIME ]; do
  sleep 5
done

if kill -0 "$PAL_PID" 2>/dev/null; then
  echo "Time's up — stopping server gracefully..."
  graceful_stop 90
elif [ ! -f "$STOP_FLAG" ]; then
  echo "::warning::Palworld server exited on its own before any stop was requested — likely a crash or OOM kill. The world may not have saved properly. Check the logs artifact."
  discord "{\"content\": \"⚠️ **Palworld server crashed unexpectedly** (not a normal stop). Check the run's logs artifact — the world may not have saved cleanly.\"}"
fi
wait $PAL_PID 2>/dev/null
echo "Server process exit code: $?"

SAVE_FILE=$(find server/Pal/Saved/SaveGames -name Level.sav -not -path '*/backup/*' 2>/dev/null | head -n1)
if [ -n "$SAVE_FILE" ]; then
  echo "Level.sav at shutdown: $SAVE_FILE ($(stat -c%s "$SAVE_FILE") bytes)"
else
  echo "No Level.sav found at shutdown."
fi

if [ -n "$POLL_PID" ] && kill -0 "$POLL_PID" 2>/dev/null; then
  echo "Stopping console poller (pid $POLL_PID)..."
  kill -TERM "$POLL_PID" 2>/dev/null || true
  for i in $(seq 1 10); do
    kill -0 "$POLL_PID" 2>/dev/null || break
    sleep 1
  done
  kill -0 "$POLL_PID" 2>/dev/null && kill -9 "$POLL_PID" 2>/dev/null
fi

docker stop playit-agent || true
docker rm playit-agent || true

if [ -n "$(git status --porcelain console/ 2>/dev/null)" ]; then
  echo "Cleaning up leftover console file state..."
  git add console/
  git commit -m "console: final state cleanup" --quiet 2>/dev/null || true
  push_console_state || true
fi

discord "{\"content\": \"🔴 **Palworld server is DOWN**\\nSession ended (was: \`$TUNNEL_ADDRESS\`)\\nWorld has been saved back to the repo.\"}"