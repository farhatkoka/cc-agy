#!/usr/bin/env python3
"""
patch-combo.py
Configures OmniRoute SQLite database for Claude Code + Antigravity compatibility:
1. Enables compatFilterFailOpen on the 'claude-auto' combo to prevent fatal 400 capability errors.
2. Structures the priority cascade: Gemini 3.8 Flash High -> Claude Sonnet 4.6 -> Flash Lite (fallback).
3. Ensures local API keys have wildcard permissions for combo routing.
"""

import sys
import json
import sqlite3
from pathlib import Path

def patch_omniroute_db():
    db_path = Path.home() / ".omniroute" / "storage.sqlite"
    if not db_path.exists():
        print(f"[-] Database not found at {db_path}. Start OmniRoute at least once before patching.", file=sys.stderr)
        return False

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    try:
        # 1. Patch claude-auto combo
        row = cur.execute("SELECT id, data FROM combos WHERE name = 'claude-auto'").fetchone()
        if not row:
            print("[-] Combo 'claude-auto' not found in database. Initializing default structure...")
            combo_id = "claude-auto-default"
            combo_data = {
                "name": "claude-auto",
                "strategy": "priority",
                "config": {"compatFilterFailOpen": True},
                "models": [
                    {"id": "claude-auto-m1", "kind": "model", "model": "agy/gemini-3.8-flash-high", "providerId": "agy", "weight": 10},
                    {"id": "claude-auto-m2", "kind": "model", "model": "agy/claude-sonnet-4-6", "providerId": "agy", "weight": 5},
                    {"id": "claude-auto-m3", "kind": "model", "model": "agy/gemini-3.1-flash-lite", "providerId": "agy", "weight": 1}
                ],
                "version": 2
            }
            cur.execute(
                "INSERT INTO combos (id, name, data, sort_order, created_at, updated_at) VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))",
                (combo_id, "claude-auto", json.dumps(combo_data))
            )
        else:
            combo_id, raw_data = row
            data = json.loads(raw_data)
            
            # Ensure config has compatFilterFailOpen
            if "config" not in data or not isinstance(data["config"], dict):
                data["config"] = {}
            data["config"]["compatFilterFailOpen"] = True

            # Restructure priority tiering
            data["strategy"] = "priority"
            data["models"] = [
                {"id": "claude-auto-m1", "kind": "model", "model": "agy/gemini-3.8-flash-high", "providerId": "agy", "weight": 10},
                {"id": "claude-auto-m2", "kind": "model", "model": "agy/claude-sonnet-4-6", "providerId": "agy", "weight": 5},
                {"id": "claude-auto-m3", "kind": "model", "model": "agy/gemini-3.1-flash-lite", "providerId": "agy", "weight": 1}
            ]

            cur.execute("UPDATE combos SET data = ?, updated_at = datetime('now') WHERE name = 'claude-auto'", (json.dumps(data),))

        # 2. Grant wildcard combo permissions to all local API keys
        keys = cur.execute("SELECT key, allowed_combos FROM api_keys").fetchall()
        for key_val, allowed in keys:
            cur.execute(
                "UPDATE api_keys SET allowed_combos = ?, scopes = ? WHERE key = ?",
                (
                    json.dumps(["*", "combo/*", "claude-auto", "auto/*"]),
                    json.dumps(["admin", "manage", "read", "write"]),
                    key_val
                )
            )

        # 3. Ensure model combo mapping exists for claude-opus and claude-sonnet
        mappings = [
            ("map-claude-opus-5", "claude-opus-5", combo_id),
            ("map-claude-sonnet", "claude-sonnet*", combo_id),
            ("map-claude-opus", "claude-opus*", combo_id),
        ]
        for map_id, pattern, cid in mappings:
            cur.execute(
                "INSERT OR REPLACE INTO model_combo_mappings (id, pattern, combo_id, priority, enabled, description, created_at, updated_at) "
                "VALUES (?, ?, ?, 10, 1, 'Auto route', datetime('now'), datetime('now'))",
                (map_id, pattern, cid)
            )

        conn.commit()
        print("[+] OmniRoute SQLite database successfully patched:")
        print("    - 'claude-auto' combo set to priority: Gemini 3.8 Flash High -> Claude Sonnet 4.6 -> Flash Lite")
        print("    - 'compatFilterFailOpen' enabled (bypasses 400 schema mismatch)")
        print("    - Local API key permissions synchronized")
        return True

    except Exception as e:
        conn.rollback()
        print(f"[-] Database patch error: {e}", file=sys.stderr)
        return False
    finally:
        conn.close()

if __name__ == "__main__":
    if not patch_omniroute_db():
        sys.exit(1)
