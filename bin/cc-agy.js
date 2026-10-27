#!/usr/bin/env node
/**
 * cc-agy: Autonomous Self-Healing CLI Wrapper & Gateway Controller
 * Seamlessly connects Claude Code to Google Antigravity (Gemini 3.8 Flash High)
 * Author: Farhat Iqbal (@farhatkoka)
 */

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const NC = '\x1b[0m';

const HOME = os.homedir();
const AGY_TOKEN_PATH = path.join(HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
const CLAUDE_SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');
const SYSTEMD_SERVICE_PATH = path.join(HOME, '.config', 'systemd', 'user', 'omniroute.service');
const HEALTH_URL = 'http://127.0.0.1:20128/api/monitoring/health';

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
      process.stdout.write(`${YELLOW}⚡ [cc-agy] Re-linking platform native ELF binary...${NC} `);
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

async function ensureDaemonRunning() {
  const isHealthy = await checkHealth(1000);
  if (isHealthy) return true;

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

  console.log(`${RED}✖ Failed to start omniroute.service.${NC}`);
  return false;
}

function getLocalApiKey() {
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
      if (data?.env?.ANTHROPIC_AUTH_TOKEN) {
        return data.env.ANTHROPIC_AUTH_TOKEN;
      }
    } catch {}
  }
  return 'sk-omniroute-local';
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

  // 1. Antigravity OAuth Token
  const hasToken = fs.existsSync(AGY_TOKEN_PATH);
  console.log(`[1] Google Antigravity Token : ${hasToken ? `${GREEN}✔ Present (${AGY_TOKEN_PATH})${NC}` : `${RED}✖ Missing. Run 'agy' to sign in.${NC}`}`);

  // 2. Gateway Service
  const serviceActive = spawnSync('systemctl', ['--user', 'is-active', 'omniroute'], { encoding: 'utf-8' }).stdout?.trim() === 'active';
  console.log(`[2] OmniRoute User Daemon     : ${serviceActive ? `${GREEN}✔ active (systemd --user)${NC}` : `${YELLOW}⚠ inactive / not running${NC}`}`);

  // 3. Local Endpoint Health
  const healthy = await checkHealth(2000);
  console.log(`[3] Gateway Health Endpoint  : ${healthy ? `${GREEN}✔ http://127.0.0.1:20128 (healthy)${NC}` : `${RED}✖ Unreachable${NC}`}`);

  // 4. Claude Code CLI Version & Binary
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

  // 5. Model Routing
  console.log(`[6] Inference Architecture   : ${BOLD}Tier 1: Gemini 3.8 Flash High (Reasoning)${NC}`);
  console.log(`                               ${BOLD}Tier 2: Claude Sonnet 4.6 (Fallback)${NC}`);
  console.log(`                               ${BOLD}Tier 3: Gemini 3.1 Flash Lite (Circuit Breaker)${NC}`);
  console.log(`[7] Token Billing / Cost     : ${GREEN}Asymmetric Zero Marginal Cost ($0 / token)${NC}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'doctor' || command === 'status') {
    await runDoctor();
    process.exit(0);
  }

  if (command === 'restart') {
    process.stdout.write(`${YELLOW}Restarting omniroute.service...${NC} `);
    spawnSync('systemctl', ['--user', 'restart', 'omniroute'], { encoding: 'utf-8' });
    const ok = await checkHealth(3000);
    console.log(ok ? `${GREEN}✔ Gateway restarted & healthy.${NC}` : `${RED}✖ Failed.${NC}`);
    process.exit(ok ? 0 : 1);
  }

  if (command === 'setup') {
    const ok = runSetup();
    process.exit(ok ? 0 : 1);
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(`
${BOLD}cc-agy${NC} - Claude Code + Google Antigravity (Gemini 3.8 Flash High) Gateway

${BOLD}USAGE:${NC}
  cc-agy [options] [claude-flags]   Launch Claude Code connected to Antigravity
  cc-agy doctor                      Run full diagnostic telemetry & healthcheck
  cc-agy restart                     Restart local proxy daemon
  cc-agy setup                       Force re-run provisioning and database patches

${BOLD}EXAMPLES:${NC}
  cc-agy
  cc-agy --dangerously-skip-permissions
  cc-agy -p "Review this file"
  cc-agy doctor
`);
    process.exit(0);
  }

  // Pre-flight setup check
  const isSetup = fs.existsSync(SYSTEMD_SERVICE_PATH) && fs.existsSync(CLAUDE_SETTINGS_PATH);
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

  // Inject gateway environment variables
  const apiKey = getLocalApiKey();
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: 'http://localhost:20128',
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  };

  // Launch Claude Code transparently
  const child = spawn('claude', args, {
    stdio: 'inherit',
    env,
  });

  child.on('exit', (code, signal) => {
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
