#!/usr/bin/env bash
# health-check-plugin SessionStart hook:
#   1. detect whether this project has a health-check config yet
#   2. surface recurring/active issues from the last run as context
#
# Pure detection — never mutates anything. Safe to run on every session.

set -uo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
CONFIG=""
for name in "health-check.config.json" ".health-check.config.json"; do
  if [ -f "$PROJECT_DIR/$name" ]; then CONFIG="$PROJECT_DIR/$name"; break; fi
done

if [ -z "$CONFIG" ]; then
  cat <<'EOF'
[HEALTH-CHECK] No health-check.config.json found in this project.
Run /health-configure (or `npx health-check init`) to scaffold one, then
/health-run to take the first reading.
EOF
  exit 0
fi

PROJECT_NAME=$(python3 -c "import json,sys; print(json.load(open('$CONFIG')).get('project','?'))" 2>/dev/null || echo "?")
echo "[HEALTH-CHECK] Config found for \"$PROJECT_NAME\". Use /health-run, /health-report, /health-issues, /health-heal."

# Inject last-run context: recurring/active issues from the local state dir.
STATE_DIR=$(python3 -c "import json; print(json.load(open('$CONFIG')).get('stateDir','.health-check'))" 2>/dev/null || echo ".health-check")
FP_FILE="$PROJECT_DIR/$STATE_DIR/fingerprint-history.json"
if [ -f "$FP_FILE" ]; then
  CTX=$(python3 - "$FP_FILE" <<'PY' 2>/dev/null
import json, sys
try:
    hist = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
active = [h for h in hist.values() if h.get("consecutiveRuns", 0) > 0]
recurring = sorted([h for h in active if h.get("consecutiveRuns", 0) >= 2],
                   key=lambda h: -h["consecutiveRuns"])[:5]
if not recurring:
    sys.exit(0)
print("Recurring health issues (persisting across runs):")
for h in recurring:
    print(f'  - {h["consecutiveRuns"]}x [{h["source"]}] {h["title"]}')
PY
)
  if [ -n "$CTX" ]; then
    cat <<EOF
<health-check-context>
$CTX
</health-check-context>
EOF
  fi
fi

exit 0
