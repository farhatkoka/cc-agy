#!/usr/bin/env node
/**
 * cc-agy: Autonomous Self-Healing CLI Wrapper & Gateway Controller
 * Seamlessly connects Claude Code to Google Antigravity (Gemini 3.8 Flash High & Claude on TPU)
 * Author: Farhat Iqbal (@farhatkoka)
 */

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const readline = require('readline');

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const NC = '\x1b[0m';

const HOME = os.homedir();
const AGY_TOKEN_PATH = path.join(HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
const CLAUDE_SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');
const SYSTEMD_SERVICE_PATH = path.join(HOME, '.config', 'systemd', 'user', 'omniroute.service');
const PID_DIR = path.join(HOME, '.omniroute');
const PID_FILE = path.join(PID_DIR, 'omniroute.pid');
const LOG_FILE = path.join(PID_DIR, 'omniroute.log');
const CONFIG_DIR = path.join(HOME, '.config', 'cc-agy');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const ISOLATED_CLAUDE_DIR = path.join(CONFIG_DIR, 'claude');
const ISOLATED_SETTINGS_PATH = path.join(ISOLATED_CLAUDE_DIR, 'settings.json');
const ISOLATED_COMMANDS_DIR = path.join(ISOLATED_CLAUDE_DIR, 'commands');
const HEALTH_URL = 'http://127.0.0.1:20128/api/monitoring/health';
const PKG_PATH = path.join(__dirname, '..', 'package.json');
let PKG_VERSION = '1.2.0';
try {
  PKG_VERSION = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')).version || '1.2.0';
} catch {}

const AGY_MODELS = [
  {
    id: 'gemini-3.8-flash-high',
    name: 'Gemini 3.8 Flash High',
    description: 'Google Deep Thinking (TPU v5p Reasoning Engine)',
    aliases: ['1', 'flash', 'high', 'flash-high', 'gemini']
  },
  {
    id: 'gemini-3.8-flash-medium',
    name: 'Gemini 3.8 Flash Medium',
    description: 'Balanced latency & test-time reasoning',
    aliases: ['2', 'medium', 'med', 'flash-medium']
  },
  {
    id: 'gemini-3.8-flash-low',
    name: 'Gemini 3.8 Flash Low',
    description: 'Distilled sub-second speed',
    aliases: ['3', 'low', 'flash-low']
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6 (Thinking)',
    description: 'Anthropic flagship agentic reasoning on TPU',
    aliases: ['4', 'sonnet', 'sonnet-4-6']
  },
  {
    id: 'claude-opus-4-6-thinking',
    name: 'Claude Opus 4.6 (Thinking)',
    description: 'Anthropic maximum depth reasoning',
    aliases: ['5', 'opus', 'opus-4-6', 'opus-thinking']
  },
  {
    id: 'gpt-oss-120b-medium',
    name: 'GPT-OSS 120B (Medium)',
    description: 'Open-weights high-density reasoning',
    aliases: ['6', 'gpt', 'oss', '120b']
  },
  {
    id: 'claude-auto',
    name: 'Claude-Auto Priority Cascade',
    description: 'Dynamic failover: Flash High -> Sonnet 4.6 -> Flash Lite',
    aliases: ['7', 'auto', 'cascade', 'default']
  }
];

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch {}
  return { defaultModel: 'gemini-3.8-flash-high' };
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    console.error(`${RED}[-] Failed to persist config:${NC}`, err.message);
  }
}

function resolveModel(query) {
  if (!query) return null;
  const q = query.trim().toLowerCase();
  for (const m of AGY_MODELS) {
    if (m.id.toLowerCase() === q) return m;
    if (m.aliases.includes(q)) return m;
  }
  return null;
}

function checkHealth(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.status === 'healthy' || res.statusCode === 200);
        } catch {
          resolve(res.statusCode === 200);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function healNativeBinary() {
  const possiblePaths = [
    path.join(HOME, '.local', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'install.cjs'),
  ];

  try {
    const globalRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf-8' }).stdout?.trim();
    if (globalRoot) {
      possiblePaths.unshift(path.join(globalRoot, '@anthropic-ai', 'claude-code', 'install.cjs'));
    }
  } catch {}

  for (const scriptPath of possiblePaths) {
    if (fs.existsSync(scriptPath)) {
      // Purge any conflicting nested platform package to prevent 'Two copies installed' error
      const nestedPkg = path.join(path.dirname(scriptPath), 'node_modules', '@anthropic-ai', 'claude-code-linux-x64');
      if (fs.existsSync(nestedPkg)) {
        try { fs.rmSync(nestedPkg, { recursive: true, force: true }); } catch {}
      }
      process.stdout.write(`${YELLOW}⚡ [cc-agy] Linking platform native ELF binary...${NC} `);
      const res = spawnSync('node', [scriptPath], { encoding: 'utf-8' });
      if (res.status === 0) {
        console.log(`${GREEN}✔ Done.${NC}`);
        return true;
      }
    }
  }
  return false;
}

function ensureNativeBinaryHealthy() {
  try {
    const res = spawnSync('claude', ['--version'], { encoding: 'utf-8' });
    const output = (res.stdout || '') + (res.stderr || '');
    if (output.includes('native binary not installed') || res.status !== 0) {
      healNativeBinary();
    }
  } catch (err) {
    healNativeBinary();
  }
}

function hasSystemd() {
  try {
    const res = spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startProcessSupervisor() {
  try {
    fs.mkdirSync(PID_DIR, { recursive: true });
    if (fs.existsSync(PID_FILE)) {
      try {
        const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (oldPid && isPidAlive(oldPid)) {
          process.kill(oldPid, 'SIGTERM');
        }
      } catch {}
      try { fs.unlinkSync(PID_FILE); } catch {}
    }

    const out = fs.openSync(LOG_FILE, 'a');
    let omniBin = 'omniroute';
    try {
      const whichRes = spawnSync('which', ['omniroute'], { encoding: 'utf8' });
      if (whichRes.status === 0 && whichRes.stdout?.trim()) {
        omniBin = whichRes.stdout.trim();
      }
    } catch {}

    const child = spawn(omniBin, ['--port', '20128'], {
      detached: true,
      stdio: ['ignore', out, out]
    });
    child.unref();
    if (child.pid) {
      fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
      return true;
    }
  } catch (err) {}
  return false;
}

async function ensureDaemonRunning() {
  const isHealthy = await checkHealth(1000);
  if (isHealthy) return true;

  if (hasSystemd()) {
    process.stdout.write(`${YELLOW}⚡ [cc-agy] Gateway daemon inactive. Resurrecting omniroute.service...${NC} `);
    try {
      spawnSync('systemctl', ['--user', 'start', 'omniroute'], { encoding: 'utf-8' });
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 400));
        if (await checkHealth(500)) {
          console.log(`${GREEN}✔ Gateway ready (:20128).${NC}`);
          return true;
        }
      }
    } catch (e) {}
  } else {
    process.stdout.write(`${YELLOW}⚡ [cc-agy] Systemd session unavailable. Launching background supervisor...${NC} `);
    startProcessSupervisor();
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 400));
      if (await checkHealth(500)) {
        console.log(`${GREEN}✔ Gateway ready (:20128).${NC}`);
        return true;
      }
    }
  }

  console.log(`${RED}✖ Failed to start OmniRoute gateway.${NC}`);
  return false;
}

function getLocalApiKey() {
  if (fs.existsSync(ISOLATED_SETTINGS_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(ISOLATED_SETTINGS_PATH, 'utf-8'));
      if (data?.env?.ANTHROPIC_AUTH_TOKEN) {
        return data.env.ANTHROPIC_AUTH_TOKEN;
      }
    } catch {}
  }
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
      if (data?.env?.ANTHROPIC_AUTH_TOKEN) {
        return data.env.ANTHROPIC_AUTH_TOKEN;
      }
    } catch {}
  }
  const sqliteDb = path.join(HOME, '.omniroute', 'storage.sqlite');
  if (fs.existsSync(sqliteDb)) {
    try {
      const res = spawnSync('sqlite3', [sqliteDb, 'SELECT key FROM api_keys LIMIT 1;'], { encoding: 'utf8' });
      if (res.status === 0 && res.stdout.trim()) {
        return res.stdout.trim().split('\n')[0].trim();
      }
    } catch {}
  }
  return 'sk-omniroute-local';
}

function ensureIsolatedProfileConfigured(apiKey) {
  try {
    fs.mkdirSync(ISOLATED_COMMANDS_DIR, { recursive: true });

    // 1. Isolated settings.json for Claude Code
    const settings = {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      env: {
        ANTHROPIC_BASE_URL: 'http://localhost:20128',
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_API_KEY: '',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_AUTOUPDATER_DISABLED_BY_HOST: '1',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '190000',
      },
      theme: 'dark-daltonized',
      includeCoAuthoredBy: false,
    };
    fs.writeFileSync(ISOLATED_SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');

    // 2. Custom slash commands: model.md and switch.md
    const commandContent = `---
name: switch
description: Switch active Google Antigravity model (Gemini 3.8 Flash, Sonnet 4.6, Opus 4.6, GPT-OSS)
command: true
---

# Antigravity Model Switch Command

Switch the active cognitive engine routed through the cc-agy gateway (:20128).  
Architect: Farhat Iqbal (@farhatkoka) · https://github.com/farhatkoka/cc-agy

## Usage
\`\`\`bash
/switch [flash | medium | low | sonnet | opus | gpt | auto]
\`\`\`

## Implementation
\`\`\`bash
cc-agy model $ARGUMENTS
\`\`\`
`;
    fs.writeFileSync(path.join(ISOLATED_COMMANDS_DIR, 'switch.md'), commandContent, 'utf8');
    fs.writeFileSync(path.join(ISOLATED_COMMANDS_DIR, 'model.md'), commandContent.replace(/name: switch/g, 'name: model'), 'utf8');

    // 3. High-velocity engineering directives (CLAUDE.md)
    const claudeMdPath = path.join(ISOLATED_CLAUDE_DIR, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      const promptContent = `# cc-agy System Directives

## Compute Environment
- **Inference Gateway:** Google Antigravity Cloud Code TPU v5p clusters (\`daily-cloudcode-pa.googleapis.com\`) via OmniRoute.
- **Cognitive Engine:** Gemini 3.8 Flash (High Reasoning) / Claude Sonnet 4.6 on TPU.
- **Operating Model:** Zero marginal token cost. High test-time compute enabled.

## Engineering Standards
- **Mechanical Precision:** Provide concrete, runnable code solutions rather than conceptual placeholders.
- **Zero Fluff:** Omit decorative pleasantries, generic apologies, and excessive verbose summaries. Focus on mechanical truth, testable diffs, and deterministic execution.
- **Idempotency:** Ensure all scripts, commands, and database operations are crash-safe and idempotent.
`;
      fs.writeFileSync(claudeMdPath, promptContent, 'utf8');
    }
  } catch (err) {}
}

function runSetup() {
  console.log(`\n${BOLD}${BLUE}=== Running cc-agy Headless Setup ===${NC}\n`);
  const installScript = path.join(__dirname, '..', 'install.sh');
  if (fs.existsSync(installScript)) {
    const child = spawnSync('bash', [installScript], { stdio: 'inherit' });
    return child.status === 0;
  } else {
    console.error(`${RED}[-] install.sh not found in package directory.${NC}`);
    return false;
  }
}

async function runDoctor() {
  console.log(`\n${BOLD}${CYAN}====================================================================${NC}`);
  console.log(`${BOLD}${CYAN}   cc-agy: System Architecture & Diagnostic Telemetry             ${NC}`);
  console.log(`${BOLD}${CYAN}====================================================================${NC}\n`);

  const hasToken = fs.existsSync(AGY_TOKEN_PATH);
  console.log(`[1] Google Antigravity Token : ${hasToken ? `${GREEN}✔ Present (${AGY_TOKEN_PATH})${NC}` : `${RED}✖ Missing. Run 'agy' to sign in.${NC}`}`);

  let serviceStatus = `${YELLOW}⚠ inactive / not running${NC}`;
  if (hasSystemd()) {
    const serviceActive = spawnSync('systemctl', ['--user', 'is-active', 'omniroute'], { encoding: 'utf-8' }).stdout?.trim() === 'active';
    serviceStatus = serviceActive ? `${GREEN}✔ active (systemd --user)${NC}` : `${YELLOW}⚠ inactive / not running${NC}`;
  } else if (fs.existsSync(PID_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (pid && isPidAlive(pid)) {
        serviceStatus = `${GREEN}✔ active (PID ${pid}, process supervisor)${NC}`;
      }
    } catch {}
  }
  console.log(`[2] OmniRoute Gateway Daemon : ${serviceStatus}`);

  const healthy = await checkHealth(2000);
  console.log(`[3] Gateway Health Endpoint  : ${healthy ? `${GREEN}✔ http://127.0.0.1:20128 (healthy)${NC}` : `${RED}✖ Unreachable${NC}`}`);

  let claudeVersion = 'Unknown';
  let binaryStatus = `${RED}✖ Broken / Unlinked${NC}`;
  try {
    const cRes = spawnSync('claude', ['--version'], { encoding: 'utf-8' });
    const cOut = (cRes.stdout || '') + (cRes.stderr || '');
    if (!cOut.includes('native binary not installed') && cRes.status === 0) {
      claudeVersion = cRes.stdout.trim();
      binaryStatus = `${GREEN}✔ Native ELF Binary Linked & Operational${NC}`;
    }
  } catch {}
  console.log(`[4] Claude Code CLI Version  : ${CYAN}${claudeVersion}${NC}`);
  console.log(`[5] Platform Native Binary   : ${binaryStatus}`);

  const cfg = loadConfig();
  const current = resolveModel(cfg.defaultModel) || AGY_MODELS[0];
  console.log(`[6] Active Cognitive Model   : ${BOLD}${CYAN}${current.name}${NC} (${current.id})`);
  console.log(`[7] Token Billing / Cost     : ${GREEN}Asymmetric Zero Marginal Cost ($0 / token)${NC}`);
  console.log(`[8] Project Repository       : ${CYAN}https://github.com/farhatkoka/cc-agy${NC} ${YELLOW}(★ Star on GitHub)${NC}\n`);
}

async function handleModelCommand(targetArg) {
  const cfg = loadConfig();
  const currentId = cfg.defaultModel || 'gemini-3.8-flash-high';

  if (targetArg) {
    const matched = resolveModel(targetArg);
    if (!matched) {
      console.log(`\n${RED}[-] Unknown model alias: '${targetArg}'${NC}`);
      console.log(`    Available aliases: flash, medium, low, sonnet, opus, gpt, auto\n`);
      process.exit(1);
    }
    cfg.defaultModel = matched.id;
    saveConfig(cfg);
    console.log(`\n${GREEN}✔ Active Antigravity Model switched to:${NC} ${BOLD}${matched.name}${NC} (${matched.id})\n`);
    return;
  }

  // Interactive Model Selector Menu
  console.log(`\n${BOLD}${CYAN}====================================================================${NC}`);
  console.log(`${BOLD}${CYAN}   cc-agy: Antigravity Model Switcher (TPU v5p Compute)             ${NC}`);
  console.log(`${BOLD}${CYAN}====================================================================${NC}\n`);

  AGY_MODELS.forEach((m, idx) => {
    const isActive = m.id === currentId;
    const marker = isActive ? `${GREEN}● [ACTIVE]${NC}` : ` `;
    const num = `${BOLD}[${idx + 1}]${NC}`;
    console.log(`  ${num} ${BOLD}${m.name.padEnd(28)}${NC} ${marker}`);
    console.log(`      ${DIM}${m.description}${NC}`);
    console.log(`      ${DIM}ID: ${m.id} | Aliases: ${m.aliases.join(', ')}${NC}\n`);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question(`${BOLD}Select model [1-7] (or press Enter to keep current): ${NC}`, (answer) => {
    rl.close();
    const trimmed = answer.trim();
    if (!trimmed) {
      console.log(`${CYAN}Retaining current active model: ${currentId}${NC}\n`);
      return;
    }
    const matched = resolveModel(trimmed);
    if (matched) {
      cfg.defaultModel = matched.id;
      saveConfig(cfg);
      console.log(`\n${GREEN}✔ Active Antigravity Model set to:${NC} ${BOLD}${matched.name}${NC} (${matched.id})\n`);
    } else {
      console.log(`\n${RED}[-] Invalid selection. Keeping ${currentId}.${NC}\n`);
    }
  });
}

async function handleUpdateCommand() {
  const pkgPath = PKG_PATH;
  let currentVersion = PKG_VERSION;
  try {
    currentVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  } catch (e) {}

  console.log(`\n${BOLD}${CYAN}cc-agy Update Engine${NC}`);
  console.log(`Current installed version: ${BOLD}v${currentVersion}${NC}`);

  // Query registry for latest published version
  let latestNpm = null;
  try {
    const res = spawnSync('npm', ['view', 'cc-agy', 'version'], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout) {
      latestNpm = res.stdout.trim();
    }
  } catch (e) {}

  if (latestNpm) {
    console.log(`Latest registry version:  ${BOLD}v${latestNpm}${NC}`);
  }

  const isGitRepo = fs.existsSync(path.join(__dirname, '..', '.git'));

  if (isGitRepo) {
    console.log(`\n${DIM}Repository checkout detected (${path.resolve(__dirname, '..')})${NC}`);
    console.log(`Syncing latest commits from GitHub origin/main...`);
    const pull = spawnSync('git', ['pull', '--rebase', 'origin', 'main'], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
    if (pull.status !== 0) {
      console.log(`\n${RED}✖ Git pull failed. Please check local git working tree.${NC}\n`);
      process.exit(1);
    }
  } else {
    console.log(`\nUpdating global npm package: ${BOLD}npm install -g cc-agy@latest${NC}...`);
    const npmUp = spawnSync('npm', ['install', '-g', 'cc-agy@latest'], {
      stdio: 'inherit',
    });
    if (npmUp.status !== 0) {
      console.log(`\n${RED}✖ npm update failed.${NC}\n`);
      process.exit(1);
    }
  }

  // Synchronize database combos if omniroute is installed
  const patchScript = path.join(__dirname, '..', 'scripts', 'patch-combo.py');
  if (fs.existsSync(patchScript)) {
    console.log(`\nSynchronizing Antigravity model combos in SQLite...`);
    spawnSync('python3', [patchScript], { stdio: 'inherit' });
  }

  // Ensure native binary link for claude-code
  ensureNativeBinaryHealthy();

  // Restart proxy daemon if running
  console.log(`Verifying gateway daemon status...`);
  if (hasSystemd()) {
    spawnSync('systemctl', ['--user', 'restart', 'omniroute.service'], { stdio: 'ignore' });
  } else {
    startProcessSupervisor();
  }

  let updatedVersion = currentVersion;
  try {
    const updatedPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    updatedVersion = updatedPkg.version;
  } catch (e) {}

  console.log(`\n${GREEN}✔ cc-agy is now at v${updatedVersion}!${NC}\n`);
  process.exit(0);
}

async function main() {
  const args = [...process.argv.slice(2)];
  const command = args[0];

  if (command === 'doctor' || command === 'status') {
    await runDoctor();
    process.exit(0);
  }

  if (command === 'restart') {
    if (hasSystemd()) {
      process.stdout.write(`${YELLOW}Restarting omniroute.service...${NC} `);
      spawnSync('systemctl', ['--user', 'restart', 'omniroute'], { encoding: 'utf-8' });
    } else {
      process.stdout.write(`${YELLOW}Restarting omniroute process supervisor...${NC} `);
      startProcessSupervisor();
    }
    const ok = await checkHealth(3000);
    console.log(ok ? `${GREEN}✔ Gateway restarted & healthy.${NC}` : `${RED}✖ Failed.${NC}`);
    process.exit(ok ? 0 : 1);
  }

  if (command === 'setup') {
    const ok = runSetup();
    process.exit(ok ? 0 : 1);
  }

  if (command === 'uninstall') {
    const uninstallScript = path.join(__dirname, '..', 'uninstall.sh');
    if (fs.existsSync(uninstallScript)) {
      const child = spawnSync('bash', [uninstallScript], { stdio: 'inherit' });
      process.exit(child.status ?? 0);
    } else {
      const child = spawnSync('bash', ['-c', 'curl -fsSL https://raw.githubusercontent.com/farhatkoka/cc-agy/main/uninstall.sh | bash'], { stdio: 'inherit' });
      process.exit(child.status ?? 0);
    }
  }

  if (command === 'update' || command === 'upgrade') {
    await handleUpdateCommand();
    return;
  }

  if (command === 'model' || command === 'models' || command === 'switch') {
    await handleModelCommand(args[1]);
    return;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(`
${BOLD}cc-agy${NC} - Claude Code + Google Antigravity (Gemini 3.8 Flash High & Claude on TPU)

${BOLD}USAGE:${NC}
  cc-agy [options] [claude-flags]   Launch Claude Code connected to Antigravity
  cc-agy model [alias]               Switch default active model (or show interactive menu)
  cc-agy update                      Self-update to the latest version & sync model combos
  cc-agy doctor                      Run full diagnostic telemetry & healthcheck
  cc-agy restart                     Restart local proxy daemon
  cc-agy setup                       Force re-run provisioning and database patches
  cc-agy uninstall                   Stop services, restore settings, and remove cc-agy

${BOLD}MODELS & ALIASES:${NC}
  flash / high                       Gemini 3.8 Flash High (Deep Reasoning)
  medium / med                       Gemini 3.8 Flash Medium
  low                                Gemini 3.8 Flash Low (Sub-second)
  sonnet                             Claude Sonnet 4.6 (Thinking on TPU)
  opus                               Claude Opus 4.6 (Thinking on TPU)
  gpt / oss                          GPT-OSS 120B (Medium)
  auto                               Priority Cascade (High -> Sonnet -> Lite)

${BOLD}EXAMPLES:${NC}
  cc-agy                             Launch with active model
  cc-agy --model sonnet              Launch a session with Claude Sonnet 4.6
  cc-agy --model opus                Launch a session with Claude Opus 4.6
  cc-agy model                       Open interactive model switcher
  cc-agy model sonnet                Set default model to Sonnet 4.6
  cc-agy --dangerously-skip-permissions
`);
    process.exit(0);
  }

  // Pre-flight setup check: verify isolated profile and daemon config
  const hasDaemonConfig = hasSystemd() ? fs.existsSync(SYSTEMD_SERVICE_PATH) : true;
  const isSetup = hasDaemonConfig && fs.existsSync(ISOLATED_SETTINGS_PATH);
  if (!isSetup) {
    if (!fs.existsSync(AGY_TOKEN_PATH)) {
      console.log(`${RED}[-] Antigravity OAuth token not found at: ${AGY_TOKEN_PATH}${NC}`);
      console.log(`    Please install and run ${BOLD}'agy'${NC} once to sign in with your Google account.`);
      process.exit(1);
    }
    const success = runSetup();
    if (!success) {
      console.error(`${RED}[-] Setup failed. Please inspect logs above.${NC}`);
      process.exit(1);
    }
  }

  // Ensure native binary and daemon are healthy
  ensureNativeBinaryHealthy();
  await ensureDaemonRunning();

  // Model resolution: check command-line --model / -m override, otherwise use saved default
  const cfg = loadConfig();
  let selectedModelId = cfg.defaultModel || 'gemini-3.8-flash-high';
  let modelIndex = -1;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' || args[i] === '-m') {
      if (args[i + 1]) {
        const resolved = resolveModel(args[i + 1]);
        if (resolved) {
          selectedModelId = resolved.id;
        } else {
          selectedModelId = args[i + 1];
        }
        modelIndex = i;
      }
      break;
    }
  }

  // Strip custom --model/-m from args to pass cleaned model id to claude
  const forwardArgs = [...args];
  if (modelIndex !== -1) {
    forwardArgs.splice(modelIndex, 2);
  }
  forwardArgs.unshift('--model', selectedModelId);

  // Inject gateway environment variables & ensure isolated profile
  const apiKey = getLocalApiKey();
  ensureIsolatedProfileConfigured(apiKey);

  const resolved = resolveModel(selectedModelId) || { name: selectedModelId };
  console.log(`${BOLD}${CYAN}▲ cc-agy${NC} ${DIM}v${PKG_VERSION} · Decoupled Antigravity Gateway${NC}`);
  console.log(`  ${BOLD}Model:${NC}   ${GREEN}${resolved.name}${NC} (${selectedModelId})`);
  console.log(`  ${BOLD}Cluster:${NC} Google Cloud TPU v5p ${DIM}(zero marginal token cost)${NC}`);
  console.log(`  ${BOLD}Profile:${NC} ${DIM}Sandboxed (~/.config/cc-agy/claude)${NC}`);
  console.log(`  ${BOLD}GitHub:${NC}  ${DIM}https://github.com/farhatkoka/cc-agy${NC} ${YELLOW}★ Drop a star!${NC}\n`);

  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: ISOLATED_CLAUDE_DIR,
    ANTHROPIC_BASE_URL: 'http://localhost:20128',
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: selectedModelId,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_AUTOUPDATER_DISABLED_BY_HOST: '1',
  };

  // Launch Claude Code transparently
  const child = spawn('claude', forwardArgs, {
    stdio: 'inherit',
    env,
  });

  child.on('exit', (code, signal) => {
    console.log(`\n${BOLD}${CYAN}▲ cc-agy${NC} ${DIM}· Thanks for coding with Antigravity TPU compute!${NC}`);
    console.log(`  ${DIM}Saving $20+/day on API tokens? Star on GitHub:${NC} ${BOLD}https://github.com/farhatkoka/cc-agy${NC}\n`);
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}

main().catch(err => {
  console.error(`${RED}[cc-agy error]:${NC}`, err);
  process.exit(1);
});
