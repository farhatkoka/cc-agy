#!/usr/bin/env python3
"""
patch-combo.py
Configures OmniRoute SQLite database for Claude Code + Antigravity compatibility:
1. Provisions exact Google Antigravity models and aliases (Gemini 3.8 Flash High/Med/Low, Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B).
2. Enables compatFilterFailOpen on combos to prevent fatal 400 capability errors.
3. Sets up fallback 'claude-auto' priority cascade.
4. Ensures local API keys have wildcard permissions for combo routing.
"""

import sys
import json
import sqlite3
from pathlib import Path

MODELS_CONFIG = [
    {
        'id': 'combo-gemini-3.8-high',
        'name': 'gemini-3.8-flash-high',
        'aliases': ['flash-high', 'flash', 'high', 'gemini'],
        'target': 'agy/gemini-3.8-flash-high'
    },
    {
        'id': 'combo-gemini-3.8-med',
        'name': 'gemini-3.8-flash-medium',
        'aliases': ['flash-medium', 'medium', 'med'],
        'target': 'agy/gemini-3.8-flash-medium'
    },
    {
        'id': 'combo-gemini-3.8-low',
        'name': 'gemini-3.8-flash-low',
        'aliases': ['flash-low', 'low'],
        'target': 'agy/gemini-3.8-flash-low'
    },
    {
        'id': 'combo-claude-sonnet-4-6',
        'name': 'claude-sonnet-4-6',
        'aliases': ['sonnet', 'sonnet-4-6'],
        'target': 'agy/claude-sonnet-4-6'
    },
    {
        'id': 'combo-claude-opus-4-6',
        'name': 'claude-opus-4-6-thinking',
        'aliases': ['opus', 'opus-4-6', 'opus-thinking'],
        'target': 'agy/claude-opus-4-6-thinking'
    },
    {
        'id': 'combo-gpt-oss-120b',
        'name': 'gpt-oss-120b-medium',
        'aliases': ['gpt', 'oss', 'gpt-oss'],
        'target': 'agy/gpt-oss-120b-medium'
    }
]

def patch_omniroute_db():
    db_path = Path.home() / ".omniroute" / "storage.sqlite"
    if not db_path.exists():
        print(f"[-] Database not found at {db_path}. Start OmniRoute at least once before patching.", file=sys.stderr)
        return False

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    try:
        # 1. Setup exact model combos and alias mappings
        for m in MODELS_CONFIG:
            combo_data = {
                'name': m['name'],
                'strategy': 'priority',
                'config': {'compatFilterFailOpen': True},
                'models': [{'id': m['id'] + '-m', 'kind': 'model', 'model': m['target'], 'providerId': 'agy', 'weight': 10}],
                'version': 2
            }
            cur.execute("""INSERT OR REPLACE INTO combos (id, name, data, updated_at, created_at) 
                           VALUES (?, ?, ?, datetime('now'), datetime('now'))""",
                        (m['id'], m['name'], json.dumps(combo_data)))

            cur.execute("""INSERT OR REPLACE INTO model_combo_mappings (id, pattern, combo_id, priority, enabled, description, created_at, updated_at)
                           VALUES (?, ?, ?, 20, 1, ?, datetime('now'), datetime('now'))""",
                        ('map-' + m['name'], m['name'], m['id'], 'Exact ' + m['name']))
            
            for alias in m['aliases']:
                cur.execute("""INSERT OR REPLACE INTO model_combo_mappings (id, pattern, combo_id, priority, enabled, description, created_at, updated_at)
                               VALUES (?, ?, ?, 15, 1, ?, datetime('now'), datetime('now'))""",
                            ('map-alias-' + alias, alias, m['id'], 'Alias ' + alias))

        # 2. Patch claude-auto priority fallback combo
        row = cur.execute("SELECT id, data FROM combos WHERE name = 'claude-auto'").fetchone()
        auto_id = "fc0a1ddb-af40-4c9d-b9ce-7e8166c3ddde"
        if not row:
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
                (auto_id, "claude-auto", json.dumps(combo_data))
            )
        else:
            auto_id, raw_data = row
            data = json.loads(raw_data)
            if "config" not in data or not isinstance(data["config"], dict):
                data["config"] = {}
            data["config"]["compatFilterFailOpen"] = True
            data["strategy"] = "priority"
            data["models"] = [
                {"id": "claude-auto-m1", "kind": "model", "model": "agy/gemini-3.8-flash-high", "providerId": "agy", "weight": 10},
                {"id": "claude-auto-m2", "kind": "model", "model": "agy/claude-sonnet-4-6", "providerId": "agy", "weight": 5},
                {"id": "claude-auto-m3", "kind": "model", "model": "agy/gemini-3.1-flash-lite", "providerId": "agy", "weight": 1}
            ]
            cur.execute("UPDATE combos SET data = ?, updated_at = datetime('now') WHERE name = 'claude-auto'", (json.dumps(data),))

        # Fallback mappings for generic legacy requests
        cur.execute("""INSERT OR REPLACE INTO model_combo_mappings (id, pattern, combo_id, priority, enabled, description, created_at, updated_at)
                       VALUES ('map-claude-fallback-sonnet', 'claude-3-5-sonnet*', ?, 5, 1, 'Default Sonnet to Auto', datetime('now'), datetime('now'))""", (auto_id,))
        cur.execute("""INSERT OR REPLACE INTO model_combo_mappings (id, pattern, combo_id, priority, enabled, description, created_at, updated_at)
                       VALUES ('map-claude-fallback-opus', 'claude-opus-5*', ?, 5, 1, 'Default Opus to Auto', datetime('now'), datetime('now'))""", (auto_id,))

        # 3. Grant wildcard combo permissions to all local API keys
        all_combos = [m['name'] for m in MODELS_CONFIG] + [a for m in MODELS_CONFIG for a in m['aliases']] + ['claude-auto', '*', 'combo/*', 'auto/*']
        keys = cur.execute("SELECT key FROM api_keys").fetchall()
        for (key_val,) in keys:
            cur.execute(
                "UPDATE api_keys SET allowed_combos = ?, scopes = ? WHERE key = ?",
                (json.dumps(all_combos), json.dumps(["admin", "manage", "read", "write"]), key_val)
            )

        conn.commit()
        print("[+] OmniRoute SQLite database successfully patched:")
        print("    - 6 exact Antigravity models and aliases mapped")
        print("    - 'claude-auto' cascade configured (Gemini 3.8 Flash High -> Sonnet 4.6 -> Flash Lite)")
        print("    - 'compatFilterFailOpen' enabled across all combos")
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
