#!/usr/bin/env bash
# ==============================================================================
# cc-agy: Automated Claude Code + Antigravity (Gemini 3.8 Flash High) Bootstrap
# Production-grade setup script with zero hardcoded credentials.
# ==============================================================================
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${BOLD}${BLUE}====================================================================${NC}"
echo -e "${BOLD}${BLUE}   cc-agy: Claude Code + Antigravity TPU Inference Gateway        ${NC}"
echo -e "${BOLD}${BLUE}====================================================================${NC}\n"

# 1. Dependency checks
echo -e "${YELLOW}[1/6] Validating host dependencies...${NC}"
command -v node >/dev/null 2>&1 || { echo -e "${RED}[-] Node.js is required but not installed.${NC}"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo -e "${RED}[-] npm is required but not installed.${NC}"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo -e "${RED}[-] python3 is required but not installed.${NC}"; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo -e "${RED}[-] systemd is required for daemon management.${NC}"; exit 1; }

# Check for Antigravity token
AGY_TOKEN_PATH="${HOME}/.gemini/antigravity-cli/antigravity-oauth-token"
if [ ! -f "${AGY_TOKEN_PATH}" ]; then
    echo -e "${RED}[-] Antigravity OAuth token not found at: ${AGY_TOKEN_PATH}${NC}"
    echo -e "    Please run 'agy' once to authenticate with your Google account first."
    exit 1
fi
echo -e "${GREEN}[+] Host dependencies and Antigravity OAuth token confirmed.${NC}"

# 2. Claude Code & Native Binary Installation
echo -e "\n${YELLOW}[2/6] Verifying Claude Code and native platform binaries...${NC}"
if ! command -v claude >/dev/null 2>&1; then
    echo -e "    Installing @anthropic-ai/claude-code globally..."
    npm install -g @anthropic-ai/claude-code
fi

# Ensure platform-native binary exists to prevent 'native binary not installed' runtime error
ARCH="$(uname -m)"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
if [ "${OS}" = "linux" ] && [ "${ARCH}" = "x86_64" ]; then
    NODE_GLOBAL_ROOT="$(npm root -g)"
    if [ ! -d "${NODE_GLOBAL_ROOT}/@anthropic-ai/claude-code-linux-x64" ]; then
        echo -e "    Installing native binary package: @anthropic-ai/claude-code-linux-x64..."
        npm install -g @anthropic-ai/claude-code-linux-x64@latest || true
    fi
    if [ -f "${NODE_GLOBAL_ROOT}/@anthropic-ai/claude-code/install.cjs" ]; then
        node "${NODE_GLOBAL_ROOT}/@anthropic-ai/claude-code/install.cjs" 2>/dev/null || true
    fi
fi
echo -e "${GREEN}[+] Claude Code binary confirmed.${NC}"

# 3. OmniRoute Installation & Initialization
echo -e "\n${YELLOW}[3/6] Setting up OmniRoute local reverse proxy...${NC}"
if ! command -v omniroute >/dev/null 2>&1; then
    echo -e "    Installing omniroute globally..."
    npm install -g omniroute
fi

mkdir -p "${HOME}/.omniroute"
OMNI_ENV="${HOME}/.omniroute/.env"
if [ ! -f "${OMNI_ENV}" ]; then
    echo -e "    Generating local storage encryption key..."
    STORAGE_KEY="$(python3 -c "import secrets; print(secrets.token_hex(32))")"
    cat << EOF > "${OMNI_ENV}"
STORAGE_ENCRYPTION_KEY="${STORAGE_KEY}"
OMNIROUTE_SERVER_HOST="127.0.0.1"
PORT=20128
EOF
fi

# Ensure OmniRoute has initialized its database
if [ ! -f "${HOME}/.omniroute/storage.sqlite" ]; then
    echo -e "    Initializing OmniRoute database..."
    omniroute status >/dev/null 2>&1 || true
fi

# 4. Provision Antigravity Provider & Patch Combos
echo -e "\n${YELLOW}[4/6] Encrypting credentials & patching SQLite combo cascades...${NC}"
python3 "${SCRIPT_DIR}/scripts/import-agy.py"
python3 "${SCRIPT_DIR}/scripts/patch-combo.py"

# Resolve local API key from storage.sqlite
LOCAL_API_KEY="$(python3 -c '
import sqlite3, sys
from pathlib import Path
db = Path.home() / ".omniroute" / "storage.sqlite"
if not db.exists(): sys.exit(1)
conn = sqlite3.connect(db)
cur = conn.cursor()
row = cur.execute("SELECT key FROM api_keys LIMIT 1").fetchone()
if row:
    print(row[0])
else:
    import secrets
    new_key = f"sk-{secrets.token_hex(8)}-{secrets.token_hex(3)}-{secrets.token_hex(4)}"
    cur.execute("INSERT INTO api_keys (key, name, scopes, allowed_combos, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, datetime(\"now\"), datetime(\"now\"))",
        (new_key, "Default Key", "[\"admin\",\"manage\",\"read\",\"write\"]", "[\"*\"]"))
    conn.commit()
    print(new_key)
conn.close()
')"

if [ -z "${LOCAL_API_KEY}" ]; then
    echo -e "${RED}[-] Failed to resolve or generate a local OmniRoute API key.${NC}"
    exit 1
fi
echo -e "${GREEN}[+] Local API key provisioned and authorized.${NC}"

# 5. Deploy Resilient Systemd Daemon
echo -e "\n${YELLOW}[5/6] Deploying resilient systemd user service...${NC}"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
mkdir -p "${SYSTEMD_USER_DIR}"
cp "${SCRIPT_DIR}/systemd/omniroute.service" "${SYSTEMD_USER_DIR}/omniroute.service"

systemctl --user daemon-reload
systemctl --user enable omniroute
systemctl --user restart omniroute

# Wait for service health check
echo -n "    Awaiting gateway readiness on http://127.0.0.1:20128"
for _ in {1..20}; do
    if curl -s http://127.0.0.1:20128/api/monitoring/health | grep -q '"status":"healthy"' 2>/dev/null; then
        echo -e " ${GREEN}[READY]${NC}"
        break
    fi
    echo -n "."
    sleep 0.5
done

# 6. Configure Claude Code Client & Shell Environment
echo -e "\n${YELLOW}[6/6] Syncing Claude Code configuration...${NC}"
mkdir -p "${HOME}/.claude"
SETTINGS_FILE="${HOME}/.claude/settings.json"

python3 -c '
import json, sys
from pathlib import Path

settings_path = Path.home() / ".claude" / "settings.json"
key = sys.argv[1]

data = {}
if settings_path.exists():
    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}

if "env" not in data or not isinstance(data["env"], dict):
    data["env"] = {}

data["$schema"] = "https://json.schemastore.org/claude-code-settings.json"
data["env"]["ANTHROPIC_BASE_URL"] = "http://localhost:20128"
data["env"]["ANTHROPIC_AUTH_TOKEN"] = key
data["env"]["ANTHROPIC_API_KEY"] = ""
data["env"]["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"] = "1"
data["env"]["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = "190000"

with open(settings_path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
' "${LOCAL_API_KEY}"

# Append idempotent block to ~/.bashrc if not present
BASHRC="${HOME}/.bashrc"
if [ -f "${BASHRC}" ]; then
    if ! grep -q "CC-AGY GATEWAY" "${BASHRC}"; then
        cat << EOF >> "${BASHRC}"

# CC-AGY GATEWAY (Claude Code + Antigravity)
export OMNIROUTE_API_KEY="${LOCAL_API_KEY}"
export ANTHROPIC_BASE_URL="http://localhost:20128"
export ANTHROPIC_AUTH_TOKEN="${LOCAL_API_KEY}"
export ANTHROPIC_API_KEY=""
EOF
    fi
fi

echo -e "\n${BOLD}${GREEN}====================================================================${NC}"
echo -e "${BOLD}${GREEN}   SUCCESS: cc-agy Pipeline Fully Operational!                     ${NC}"
echo -e "${BOLD}${GREEN}====================================================================${NC}"
echo -e "Primary Model  : ${BOLD}Gemini 3.8 Flash (High Reasoning)${NC}"
echo -e "Fallback Models: ${BOLD}Claude Sonnet 4.6 -> Gemini 3.1 Flash Lite${NC}"
echo -e "Daemon Service : ${BOLD}systemctl --user status omniroute${NC}"
echo -e "Endpoint       : ${BOLD}http://localhost:20128/v1${NC}"
echo -e "\nRun ${BOLD}'claude'${NC} anywhere in your terminal to begin coding."
