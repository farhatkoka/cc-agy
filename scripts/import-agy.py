#!/usr/bin/env python3
"""
import-agy.py
Discovers the user's local Antigravity CLI OAuth token, encrypts credentials with OmniRoute's
storage key, and provisions the 'agy' provider connection in OmniRoute's SQLite database.
Zero secrets hardcoded. Reads purely from local runtime paths.
"""

import os
import sys
import json
import uuid
import sqlite3
import hashlib
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def get_env_value(env_path: Path, key: str) -> str:
    if not env_path.exists():
        return ""
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith(f"{key}="):
                val = line.split("=", 1)[1].strip()
                if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                    val = val[1:-1]
                return val
    return ""

def encrypt_credentials(creds_dict: dict, encryption_key_hex: str) -> str:
    key_bytes = bytes.fromhex(encryption_key_hex) if len(encryption_key_hex) == 64 else hashlib.sha256(encryption_key_hex.encode()).digest()
    aesgcm = AESGCM(key_bytes)
    iv = os.urandom(12)
    plaintext = json.dumps(creds_dict).encode("utf-8")
    ciphertext_and_tag = aesgcm.encrypt(iv, plaintext, None)
    ciphertext = ciphertext_and_tag[:-16]
    tag = ciphertext_and_tag[-16:]
    return f"{iv.hex()}:{tag.hex()}:{ciphertext.hex()}"

def import_agy():
    token_file = Path.home() / ".gemini" / "antigravity-cli" / "antigravity-oauth-token"
    if not token_file.exists():
        print(f"[-] Antigravity token not found at {token_file}", file=sys.stderr)
        print("    Run 'agy' once to complete Google OAuth authentication first.", file=sys.stderr)
        return False

    with open(token_file, "r", encoding="utf-8") as f:
        token_data = json.load(f)

    token_obj = token_data.get("token", token_data)
    access_token = token_obj.get("access_token")
    refresh_token = token_obj.get("refresh_token")
    if not access_token or not refresh_token:
        print("[-] Invalid token file: missing access_token or refresh_token", file=sys.stderr)
        return False

    omni_env = Path.home() / ".omniroute" / ".env"
    enc_key = get_env_value(omni_env, "STORAGE_ENCRYPTION_KEY")
    if not enc_key:
        print(f"[-] STORAGE_ENCRYPTION_KEY not found in {omni_env}", file=sys.stderr)
        print("    Ensure OmniRoute is installed and initialized.", file=sys.stderr)
        return False

    creds_payload = {
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "tokenType": "Bearer",
        "expiresAt": token_obj.get("expiry") or token_obj.get("expires_at"),
        "email": token_data.get("id_token_email", ""),
        "authMethod": "consumer",
        "providerSpecificData": {
            "projectId": "cloudaicompanion-prod"
        }
    }

    encrypted_blob = encrypt_credentials(creds_payload, enc_key)

    db_path = Path.home() / ".omniroute" / "storage.sqlite"
    if not db_path.exists():
        print(f"[-] Database not found at {db_path}", file=sys.stderr)
        return False

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    try:
        row = cur.execute("SELECT id FROM provider_connections WHERE provider = 'agy'").fetchone()
        if row:
            conn_id = row[0]
            cur.execute(
                "UPDATE provider_connections SET credentials = ?, is_active = 1, updated_at = datetime('now') WHERE id = ?",
                (encrypted_blob, conn_id)
            )
            print(f"[+] Updated existing 'agy' provider connection ({conn_id[:8]}...)")
        else:
            conn_id = str(uuid.uuid4())
            cur.execute(
                "INSERT INTO provider_connections (id, provider, name, auth_type, credentials, is_active, created_at, updated_at) "
                "VALUES (?, 'agy', 'Antigravity CLI (Imported)', 'oauth', ?, 1, datetime('now'), datetime('now'))",
                (conn_id, encrypted_blob)
            )
            print(f"[+] Created new 'agy' provider connection ({conn_id[:8]}...)")

        conn.commit()
        return True
    except Exception as e:
        conn.rollback()
        print(f"[-] Error updating provider connection: {e}", file=sys.stderr)
        return False
    finally:
        conn.close()

if __name__ == "__main__":
    if not import_agy():
        sys.exit(1)
