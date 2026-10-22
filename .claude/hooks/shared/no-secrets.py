#!/usr/bin/env python3
# ~/.claude/hooks/no-secrets.py
"""Block hardcoded secrets"""

import json
import re
import sys

SECRET_PATTERNS = [
    (r"sk_live_[a-zA-Z0-9]+", "Stripe live key detected"),
    (r"sk-[a-zA-Z0-9]{48}", "OpenAI key detected"),
    (r"supabase_service_role_key\s*=\s*['\"][^'\"]+['\"]", "Supabase service role key hardcoded"),
    (r"SUPABASE_SERVICE_ROLE_KEY\s*=\s*['\"][^'\"]+['\"]", "Supabase service role key hardcoded"),
    (r"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+", "JWT token detected"),
    (r"password\s*=\s*['\"][^'\"]{8,}['\"]", "Possible hardcoded password"),
]

IGNORED_FILES = [".env.example", ".env.template", "README.md"]

def main():
    input_data = json.load(sys.stdin)
    
    if input_data.get("tool_name") not in ("Write", "Edit"):
        sys.exit(0)
    
    tool_input = input_data.get("tool_input", {})
    file_path = tool_input.get("file_path", "") or tool_input.get("path", "")
    content = tool_input.get("content", "") or tool_input.get("new_string", "")
    
    # Skip example files
    if any(ignored in file_path for ignored in IGNORED_FILES):
        sys.exit(0)
    
    for pattern, message in SECRET_PATTERNS:
        if re.search(pattern, content):
            print(f"🛑 {message} — use environment variables", file=sys.stderr)
            sys.exit(2)
    
    sys.exit(0)

if __name__ == "__main__":
    main()