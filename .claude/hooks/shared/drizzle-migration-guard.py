#!/usr/bin/env python3
"""
PreToolUse hook: Drizzle Migration Guard
Prevents dangerous schema changes and validates migrations for safety.

Checks:
- Destructive operations (DROP TABLE, DROP COLUMN)
- Risky operations (ALTER COLUMN TYPE, NOT NULL without default)
- Migration file naming conventions
- Schema file patterns
"""

import json
import re
import sys
from pathlib import Path

# Dangerous SQL patterns that should be blocked or warned
DANGEROUS_PATTERNS = [
    # Destructive - Block these
    (r'\bDROP\s+TABLE\b', 'error', '🚨 DROP TABLE detected - this will delete all data!'),
    (r'\bDROP\s+SCHEMA\b', 'error', '🚨 DROP SCHEMA detected - this will delete entire schema!'),
    (r'\bTRUNCATE\b', 'error', '🚨 TRUNCATE detected - this will delete all rows!'),
    (r'\bDELETE\s+FROM\s+\w+\s*;', 'error', '🚨 DELETE without WHERE - this will delete all rows!'),

    # High risk - Warn and require confirmation
    (r'\bDROP\s+COLUMN\b', 'warn', '⚠️  DROP COLUMN detected - data will be lost'),
    (r'\bALTER\s+COLUMN\s+\w+\s+SET\s+DATA\s+TYPE\b', 'warn', '⚠️  Column type change - may cause data loss or errors'),
    (r'\bALTER\s+TABLE\s+\w+\s+ALTER\s+COLUMN\s+\w+\s+TYPE\b', 'warn', '⚠️  Column type change - may cause data loss'),
    (r'\bDROP\s+TYPE\b', 'warn', '⚠️  DROP TYPE detected - ensure no columns use this type'),
    (r'\bDROP\s+INDEX\b', 'info', 'ℹ️  DROP INDEX - may affect query performance'),
    (r'\bDROP\s+CONSTRAINT\b', 'warn', '⚠️  DROP CONSTRAINT - may affect data integrity'),

    # NOT NULL without default (risky for existing data)
    (r'\bSET\s+NOT\s+NULL\b(?!.*DEFAULT)', 'warn', '⚠️  SET NOT NULL without DEFAULT - will fail if nulls exist'),
    (r'\bNOT\s+NULL\b(?!.*DEFAULT)(?!.*PRIMARY)', 'info', 'ℹ️  NOT NULL column - ensure default value or empty table'),
]

# Schema file patterns to check
SCHEMA_WARNINGS = [
    # Drizzle schema patterns
    (r'\.dropTable\s*\(', 'error', '🚨 dropTable() in schema - generates DROP TABLE migration'),
    (r'\.dropColumn\s*\(', 'warn', '⚠️  dropColumn() - will generate DROP COLUMN migration'),
    (r'\.alterColumn\s*\([^)]+\)\.setDataType\s*\(', 'warn', '⚠️  setDataType() - may cause data loss'),
]

# Files/paths to check
MIGRATION_PATHS = ['migrations/', 'packages/db/migrations/']
SCHEMA_PATHS = ['schema/', 'packages/db/schema/']


def is_migration_file(file_path: str) -> bool:
    """Check if file is a migration file."""
    path = Path(file_path)
    return (
        path.suffix == '.sql' and
        any(mp in file_path for mp in MIGRATION_PATHS)
    )


def is_schema_file(file_path: str) -> bool:
    """Check if file is a Drizzle schema file."""
    path = Path(file_path)
    return (
        path.suffix == '.ts' and
        any(sp in file_path for sp in SCHEMA_PATHS) and
        'index.ts' not in file_path
    )


def check_content(content: str, patterns: list, file_type: str) -> tuple[list, list, list]:
    """Check content against patterns. Returns (errors, warnings, info)."""
    errors = []
    warnings = []
    info = []

    for pattern, level, message in patterns:
        if re.search(pattern, content, re.IGNORECASE | re.MULTILINE):
            if level == 'error':
                errors.append(message)
            elif level == 'warn':
                warnings.append(message)
            else:
                info.append(message)

    return errors, warnings, info


def check_migration_naming(file_path: str) -> list:
    """Check migration file naming convention."""
    warnings = []
    path = Path(file_path)

    # Drizzle uses format: NNNN_name.sql
    if not re.match(r'^\d{4}_', path.name):
        warnings.append(f"⚠️  Migration naming: Expected format NNNN_name.sql, got {path.name}")

    return warnings


def analyze_file(file_path: str, content: str) -> dict:
    """Analyze a file for dangerous patterns."""
    result = {
        'errors': [],
        'warnings': [],
        'info': [],
        'file_type': None
    }

    if is_migration_file(file_path):
        result['file_type'] = 'migration'
        errors, warnings, info = check_content(content, DANGEROUS_PATTERNS, 'migration')
        result['errors'].extend(errors)
        result['warnings'].extend(warnings)
        result['info'].extend(info)
        result['warnings'].extend(check_migration_naming(file_path))

    elif is_schema_file(file_path):
        result['file_type'] = 'schema'
        errors, warnings, info = check_content(content, SCHEMA_WARNINGS, 'schema')
        result['errors'].extend(errors)
        result['warnings'].extend(warnings)
        result['info'].extend(info)

    return result


def main():
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})

    # Only check Write and Edit operations
    if tool_name not in ("Write", "Edit", "MultiEdit"):
        sys.exit(0)

    file_path = tool_input.get("file_path", "") or tool_input.get("path", "")
    content = tool_input.get("content", "") or tool_input.get("new_string", "")

    if not file_path or not content:
        sys.exit(0)

    # Skip if not a relevant file
    if not (is_migration_file(file_path) or is_schema_file(file_path)):
        sys.exit(0)

    # Analyze the content
    result = analyze_file(file_path, content)

    # Block if there are errors
    if result['errors']:
        output = []
        output.append(f"\n🛑 Drizzle Migration Guard: Dangerous operation detected!")
        output.append(f"   File: {Path(file_path).name}")
        output.append("")

        for error in result['errors']:
            output.append(f"   {error}")

        if result['warnings']:
            output.append("")
            output.append("   Additional warnings:")
            for warning in result['warnings']:
                output.append(f"   {warning}")

        output.append("")
        output.append("   💡 If this is intentional:")
        output.append("   • Ensure you have a backup of the data")
        output.append("   • Consider using a data migration script first")
        output.append("   • Review with: pnpm db:studio")
        output.append("")

        print("\n".join(output), file=sys.stderr)
        sys.exit(2)

    # Warn but allow if there are only warnings
    if result['warnings']:
        output = []
        output.append(f"\n⚠️  Drizzle Migration Guard: Risky operations detected")
        output.append(f"   File: {Path(file_path).name}")
        output.append("")

        for warning in result['warnings']:
            output.append(f"   {warning}")

        output.append("")
        output.append("   💡 Recommendations:")
        output.append("   • Review the migration carefully before applying")
        output.append("   • Test on a development database first")
        output.append("   • Consider backup before pnpm db:migrate")
        output.append("")

        # Print to stderr but don't block (exit 0)
        print("\n".join(output), file=sys.stderr)

    sys.exit(0)


if __name__ == "__main__":
    main()
