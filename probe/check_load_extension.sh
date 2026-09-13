#!/usr/bin/env bash
# Determine whether --load-extension is honoured at all on this Chrome build,
# independent of remote debugging. Kills by PID (never pkill -f, which matches
# the harness's own command line and terminates the caller).
set -u

PROFILE="$1"
shift

rm -rf "$PROFILE"
google-chrome --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
  "$@" about:blank >/dev/null 2>&1 &
CHROME_PID=$!
sleep 14
kill -TERM "$CHROME_PID" 2>/dev/null
wait "$CHROME_PID" 2>/dev/null
sleep 2

python3 - "$PROFILE" <<'EOF'
import json, os, sys
profile = sys.argv[1]
found = False
for name in ("Preferences", "Secure Preferences"):
    p = os.path.join(profile, "Default", name)
    if not os.path.exists(p):
        print(f"{name}: missing")
        continue
    d = json.load(open(p))
    s = d.get("extensions", {}).get("settings", {})
    print(f"--- {name}: {len(s)} extension entries ---")
    for eid, meta in s.items():
        path = str(meta.get("path", ""))
        # location 4 == LOAD_COMMAND_LINE (unpacked via --load-extension)
        if "tabscribe" in path.lower() or "hello-ext" in path.lower() or meta.get("location") == 4:
            found = True
            print(f"  id={eid} location={meta.get('location')} state={meta.get('state')}")
            print(f"    path={path}")
print("\nRESULT:", "LOADED" if found else "NOT LOADED")
EOF
