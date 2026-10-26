#!/usr/bin/env bash
# ==============================================================================
# cc-agy: Uninstaller
# Restores original Claude Code settings, stops systemd service, and cleans up.
# ==============================================================================
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BOLD}${YELLOW}Uninstalling cc-agy Gateway...${NC}"

# 1. Stop and disable systemd service
if systemctl --user is-active --quiet omniroute 2>/dev/null; then
    echo -e "    Stopping omniroute systemd user service..."
    systemctl --user stop omniroute 2>/dev/null || true
fi

if systemctl --user is-enabled --quiet omniroute 2>/dev/null; then
    echo -e "    Disabling omniroute systemd user service..."
    systemctl --user disable omniroute 2>/dev/null || true
fi

rm -f "${HOME}/.config/systemd/user/omniroute.service"
systemctl --user daemon-reload

# 2. Clean ~/.claude/settings.json
SETTINGS_FILE="${HOME}/.claude/settings.json"
if [ -f "${SETTINGS_FILE}" ]; then
    echo -e "    Restoring ~/.claude/settings.json..."
    python3 -c '
import json
from pathlib import Path
p = Path.home() / ".claude" / "settings.json"
try:
    with open(p, "r") as f:
        data = json.load(f)
    if "env" in data:
        data["env"].pop("ANTHROPIC_BASE_URL", None)
        data["env"].pop("ANTHROPIC_AUTH_TOKEN", None)
        data["env"].pop("ANTHROPIC_API_KEY", None)
    with open(p, "w") as f:
        json.dump(data, f, indent=2)
except Exception:
    pass
'
fi

# 3. Clean ~/.bashrc
BASHRC="${HOME}/.bashrc"
if [ -f "${BASHRC}" ]; then
    echo -e "    Cleaning ~/.bashrc exports..."
    sed -i '/# CC-AGY GATEWAY/,+5d' "${BASHRC}" 2>/dev/null || true
fi

echo -e "${BOLD}${GREEN}[+] cc-agy gateway successfully uninstalled.${NC}"
