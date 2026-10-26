#!/usr/bin/env python3
"""
PreToolUse hook: Drizzle Migration Guard
Blocks destructive SQL in migrations and dropTable() in Drizzle schema files.

Only blocks. A PreToolUse hook that exits 0 never shows its stderr to Claude,
so warn-only checks had no effect and were removed.
"""

import json
import re
import sys
from pathlib import Path

MIGRATION_PATTERNS = [
    (r'\bDROP\s+TABLE\b', 'DROP TABLE detected - this will delete all data!'),
    (r'\bDROP\s+SCHEMA\b', 'DROP SCHEMA detected - this will delete entire schema!'),
    (r'\bTRUNCATE\b', 'TRUNCATE detected - this will delete all rows!'),
    (r'\bDELETE\s+FROM\s+\w+\s*;', 'DELETE without WHERE - this will delete all rows!'),
]

SCHEMA_PATTERNS = [
    (r'\.dropTable\s*\(', 'dropTable() in schema - generates DROP TABLE migration'),
]

MIGRATION_PATHS = ['migrations/', 'packages/db/migrations/']
SCHEMA_PATHS = ['schema/', 'packages/db/schema/']


def is_migration_file(file_path: str) -> bool:
    return Path(file_path).suffix == '.sql' and any(mp in file_path for mp in MIGRATION_PATHS)


def is_schema_file(file_path: str) -> bool:
    return (
        Path(file_path).suffix == '.ts' and
        any(sp in file_path for sp in SCHEMA_PATHS) and
        'index.ts' not in file_path
    )


def main():
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    if input_data.get("tool_name", "") not in ("Write", "Edit", "MultiEdit"):
        sys.exit(0)

    tool_input = input_data.get("tool_input", {})
    file_path = tool_input.get("file_path", "") or tool_input.get("path", "")
    content = tool_input.get("content", "") or tool_input.get("new_string", "")

    if not file_path or not content:
        sys.exit(0)

    if is_migration_file(file_path):
        patterns = MIGRATION_PATTERNS
    elif is_schema_file(file_path):
        patterns = SCHEMA_PATTERNS
    else:
        sys.exit(0)

    errors = [msg for pattern, msg in patterns if re.search(pattern, content, re.IGNORECASE | re.MULTILINE)]
    if not errors:
        sys.exit(0)

    output = [f"🛑 Drizzle Migration Guard blocked an edit to {Path(file_path).name}:"]
    output += [f"   {e}" for e in errors]
    output.append("   If this is intentional, ask the user to confirm and to back up the data first.")
    print("\n".join(output), file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main()
