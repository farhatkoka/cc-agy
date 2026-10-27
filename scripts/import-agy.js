#!/usr/bin/env node
/**
 * import-agy.js
 * Provisions Antigravity credentials into OmniRoute SQLite using AES-256-GCM.
 * Zero external pip/npm dependencies (pure Node.js standard library).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function getEnvValue(envPath, key) {
  if (!fs.existsSync(envPath)) return null;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`)) {
      let val = trimmed.slice(key.length + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      return val;
    }
  }
  return null;
}

function encrypt(text, staticKey) {
  if (!text) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', staticKey, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `enc:v1:${iv.toString('hex')}:${enc}:${tag}`;
}

function main() {
  const home = os.homedir();
  const tokenFile = path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  if (!fs.existsSync(tokenFile)) {
    console.error(`[-] Antigravity token not found at: ${tokenFile}`);
    console.error(`    Run 'agy' once to sign in with your Google account first.`);
    process.exit(1);
  }

  const tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  const tokenObj = tokenData.token || tokenData;
  const accessToken = tokenObj.access_token;
  const refreshToken = tokenObj.refresh_token;

  if (!accessToken || !refreshToken) {
    console.error(`[-] Missing access_token or refresh_token in token file.`);
    process.exit(1);
  }

  const omniEnv = path.join(home, '.omniroute', '.env');
  const encKey = getEnvValue(omniEnv, 'STORAGE_ENCRYPTION_KEY');
  if (!encKey) {
    console.error(`[-] STORAGE_ENCRYPTION_KEY not found in ${omniEnv}`);
    process.exit(1);
  }

  const staticKey = crypto.scryptSync(encKey, 'omniroute-field-encryption-v1', 32);
  const encAccessToken = encrypt(accessToken, staticKey);
  const encRefreshToken = encrypt(refreshToken, staticKey);

  const email = tokenData.id_token_email || '';
  const projectId = 'aicode-consumers';
  const expiresAt = tokenObj.expiry || tokenObj.expires_at || new Date(Date.now() + 3600000).toISOString();

  const providerSpecificData = JSON.stringify({
    clientProfile: 'cli',
    tokenType: 'Bearer',
    authMethod: 'consumer',
    importedAt: new Date().toISOString(),
    projectId,
    tier: 'g1-pro-tier',
    subscriptionTier: 'Google AI Pro',
    plan: 'Pro'
  });

  const dbPath = path.join(home, '.omniroute', 'storage.sqlite');
  if (!fs.existsSync(dbPath)) {
    console.error(`[-] OmniRoute database not found at ${dbPath}`);
    process.exit(1);
  }

  // Use python3 sqlite3 to run parametrized SQL safely
  const pythonScript = `
import sys, sqlite3, uuid

db_path, access_token, refresh_token, email, project_id, expires_at, spec_data = sys.argv[1:8]
conn = sqlite3.connect(db_path)
cur = conn.cursor()

row = cur.execute("SELECT id FROM provider_connections WHERE provider = 'agy'").fetchone()
if row:
    conn_id = row[0]
    cur.execute("""
        UPDATE provider_connections 
        SET access_token = ?, refresh_token = ?, email = ?, project_id = ?, 
            expires_at = ?, provider_specific_data = ?, is_active = 1, updated_at = datetime('now')
        WHERE id = ?
    """, (access_token, refresh_token, email, project_id, expires_at, spec_data, conn_id))
    print(f"[+] Synchronized existing 'agy' credentials ({conn_id[:8]}...)")
else:
    conn_id = str(uuid.uuid4())
    cur.execute("""
        INSERT INTO provider_connections 
        (id, provider, name, auth_type, access_token, refresh_token, email, project_id, expires_at, provider_specific_data, is_active, created_at, updated_at)
        VALUES (?, 'agy', 'Antigravity CLI (Imported)', 'oauth', ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    """, (conn_id, access_token, refresh_token, email, project_id, expires_at, spec_data))
    print(f"[+] Created 'agy' provider connection ({conn_id[:8]}...)")

conn.commit()
conn.close()
`;

  const res = spawnSync('python3', [
    '-c', pythonScript,
    dbPath,
    encAccessToken,
    encRefreshToken,
    email,
    projectId,
    expiresAt,
    providerSpecificData
  ], { encoding: 'utf-8' });

  if (res.status !== 0) {
    console.error(`[-] SQLite update failed:`, res.stderr);
    process.exit(1);
  } else {
    process.stdout.write(res.stdout);
  }
}

main();
