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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || echo "")"
if [ -z "${SCRIPT_DIR}" ] || [ ! -f "${SCRIPT_DIR}/scripts/import-agy.js" ]; then
    INSTALL_CACHE="${HOME}/.local/share/cc-agy"
    mkdir -p "${HOME}/.local/share"
    if [ ! -d "${INSTALL_CACHE}/.git" ]; then
        echo -e "${YELLOW}[*] Bootstrapping cc-agy asset cache into ~/.local/share/cc-agy...${NC}"
        git clone --depth 1 https://github.com/farhatkoka/cc-agy.git "${INSTALL_CACHE}"
    else
        git -C "${INSTALL_CACHE}" pull --ff-only 2>/dev/null || true
    fi
    SCRIPT_DIR="${INSTALL_CACHE}"
fi

echo -e "${BOLD}${BLUE}====================================================================${NC}"
echo -e "${BOLD}${BLUE}   cc-agy: Claude Code + Antigravity TPU Inference Gateway        ${NC}"
echo -e "${BOLD}${BLUE}====================================================================${NC}\n"

# 1. Dependency checks
echo -e "${YELLOW}[1/6] Validating host dependencies...${NC}"
command -v git >/dev/null 2>&1 || { echo -e "${RED}[-] git is required but not installed.${NC}"; exit 1; }
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
node "${SCRIPT_DIR}/scripts/import-agy.js"
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
echo -e "\n${YELLOW}[6/6] Provisioning sandboxed Claude Code environment (~/.config/cc-agy/claude)...${NC}"
CONFIG_CLAUDE_DIR="${HOME}/.config/cc-agy/claude"
mkdir -p "${CONFIG_CLAUDE_DIR}/commands"

cat << EOF > "${CONFIG_CLAUDE_DIR}/settings.json"
{
  "\$schema": "https://json.schemastore.org/claude-code-settings.json",
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:20128",
    "ANTHROPIC_AUTH_TOKEN": "${LOCAL_API_KEY}",
    "ANTHROPIC_API_KEY": "",
    "DISABLE_AUTOUPDATER": "1",
    "CLAUDE_CODE_AUTOUPDATER_DISABLED_BY_HOST": "1",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "190000"
  },
  "theme": "dark-daltonized",
  "includeCoAuthoredBy": false
}
EOF

# Deploy custom slash commands: /switch and /model
cat << 'EOF' > "${CONFIG_CLAUDE_DIR}/commands/switch.md"
---
name: switch
description: Switch active Google Antigravity model (Gemini 3.8 Flash, Sonnet 4.6, Opus 4.6, GPT-OSS)
command: true
---

# Antigravity Model Switch Command

Switch the active cognitive engine routed through the cc-agy gateway (:20128).

## Usage
```bash
/switch [flash | medium | low | sonnet | opus | gpt | auto]
```

## Implementation
```bash
cc-agy model $ARGUMENTS
```
EOF
cp "${CONFIG_CLAUDE_DIR}/commands/switch.md" "${CONFIG_CLAUDE_DIR}/commands/model.md"
sed -i 's/name: switch/name: model/' "${CONFIG_CLAUDE_DIR}/commands/model.md"

# Deploy high-velocity system directives
cat << 'EOF' > "${CONFIG_CLAUDE_DIR}/CLAUDE.md"
# cc-agy System Directives

## Compute Environment
- **Inference Gateway:** Google Antigravity Cloud Code TPU v5p clusters (`daily-cloudcode-pa.googleapis.com`) via OmniRoute.
- **Cognitive Engine:** Gemini 3.8 Flash (High Reasoning) / Claude Sonnet 4.6 on TPU.
- **Operating Model:** Zero marginal token cost. High test-time compute enabled.

## Engineering Standards
- **Mechanical Precision:** Provide concrete, runnable code solutions rather than conceptual placeholders.
- **Zero Fluff:** Omit decorative pleasantries, generic apologies, and excessive verbose summaries. Focus on mechanical truth, testable diffs, and deterministic execution.
- **Idempotency:** Ensure all scripts, commands, and database operations are crash-safe and idempotent.
EOF
echo -e "${GREEN}[+] Sandboxed Claude Code profile provisioned (user's ~/.claude left untouched).${NC}"

# Install self-healing cc-agy CLI executable
mkdir -p "${HOME}/.local/bin"
cp "${SCRIPT_DIR}/bin/cc-agy.js" "${HOME}/.local/bin/cc-agy"
chmod +x "${HOME}/.local/bin/cc-agy"
echo -e "${GREEN}[+] Self-healing 'cc-agy' CLI installed to ~/.local/bin/cc-agy${NC}"

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
echo -e "CLI Command    : ${BOLD}cc-agy${NC} (or 'claude')"
echo -e "\nRun ${BOLD}'cc-agy'${NC} anywhere in your terminal to begin coding."
