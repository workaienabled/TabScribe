#!/usr/bin/env bash
# Kill leftover test Chrome instances and free the fixture HTTP port.
#
# Safety, in order of importance:
#
# 1. Do NOT use pgrep/pkill -f with a broad pattern. The agent's own shell command
#    line contains these words, so a -f match terminates the caller.
# 2. Only ever kill Chrome processes whose --user-data-dir is under one of the test
#    profile prefixes below. The user's real browser has no /tmp profile and must
#    never be matched. Every kill is by explicit PID after inspecting /proc.
#
# Test profiles live under two prefixes: /tmp/tabscribe* (suite fixtures) and
# /tmp/ts-* (design probes). Matching only the first is what once left eleven
# orphaned probe processes running after the suites reported a clean state.
set -u

PROFILE_RE='user-data-dir=/tmp/(tabscribe|ts-)'

read_cmdline() {
  # A PID can vanish between the pgrep listing and this read (children exit as
  # their parent dies). The redirect itself fails in that case, and the shell
  # reports it before `tr` ever runs — so stderr must be silenced on the whole
  # compound, not just on the command inside it.
  { tr '\0' ' ' < "/proc/$1/cmdline"; } 2>/dev/null
}

kill_pass() {
  local sig="$1" killed=0
  for pid in $(pgrep -u "$(id -u)" -x chrome 2>/dev/null); do
    cmdline=$(read_cmdline "$pid")
    [ -n "$cmdline" ] || continue
    if printf '%s' "$cmdline" | grep -Eq "$PROFILE_RE"; then
      # Browser parents take their children with them; children that outlive the
      # parent are caught on the next pass.
      kill "-$sig" "$pid" 2>/dev/null && killed=$((killed + 1))
    fi
  done
  echo "$killed"
}

n=$(kill_pass TERM)
echo "terminated $n test chrome process(es)"
sleep 2

# Anything still holding on after SIGTERM gets SIGKILL.
survivors=$(kill_pass KILL)
if [ "$survivors" != "0" ]; then
  echo "force-killed $survivors stubborn process(es)"
  sleep 1
fi

# Report anything that somehow remains, rather than exiting as if clean.
left=0
for pid in $(pgrep -u "$(id -u)" -x chrome 2>/dev/null); do
  cmdline=$(read_cmdline "$pid")
  [ -n "$cmdline" ] || continue
  if printf '%s' "$cmdline" | grep -Eq "$PROFILE_RE"; then
    echo "WARNING: test chrome still running: pid $pid"
    left=$((left + 1))
  fi
done

if command -v fuser >/dev/null 2>&1; then
  fuser -k 8899/tcp >/dev/null 2>&1 || true
fi
sleep 1
if ss -ltn 2>/dev/null | grep -q ':8899'; then
  echo "port 8899 STILL BUSY"
  exit 1
fi
echo "port 8899 free"
[ "$left" = 0 ] || exit 1
