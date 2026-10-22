#!/usr/bin/env python3
"""
Stop hook: runs type/lint verification checks after Claude stops.

Registered with `asyncRewake` in settings.json: Claude Code runs it in the
background, so the Stop event returns immediately, and exit 2 wakes Claude with
the errors. Before, the result only went to a log file and a notification, so
Claude never saw a failed check.

Full output is still written to .claude/logs/last-verify.txt.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


# ── Project detection ────────────────────────────────────────────────


def find_project_root() -> Path | None:
    """Find the project root via git, fall back to cwd."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            return Path(result.stdout.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass

    # Fallback: walk up looking for project markers
    cwd = Path.cwd()
    for directory in [cwd] + list(cwd.parents):
        if any((directory / m).exists() for m in ["package.json", "pyproject.toml", "Cargo.toml"]):
            return directory
        if directory == Path.home():
            break
    return None


JS_EXTENSIONS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".svelte")

# A turn that touches more packages than this is rare; the cap keeps a sweeping
# refactor from queueing a dozen 20-90s checks in the background.
MAX_PACKAGES = 5

Check = tuple[str, list[str], Path, int]


def has_svelte_config(directory: Path) -> bool:
    return (directory / "svelte.config.js").exists() or (directory / "svelte.config.ts").exists()


def package_checks(project_root: Path, changed: set[str]) -> list[Check]:
    """One check per workspace package that has a changed JS/TS/Svelte file.

    In a monorepo the tsconfig and svelte.config live in the packages, so a
    root-level check either finds nothing to run (frontq) or runs a root tsc
    that never sees the Svelte files (dronelist). Prefers the package's own
    `check:light` / `check` script so `svelte-kit sync` and its tsconfig apply.
    """
    packages: list[Path] = []
    for rel in sorted(changed):
        if not rel.endswith(JS_EXTENSIONS):
            continue
        for directory in (project_root / rel).parents:
            if directory == project_root:
                break
            if (directory / "package.json").exists():
                if directory not in packages:
                    packages.append(directory)
                break

    checks: list[Check] = []
    for pkg in packages[:MAX_PACKAGES]:
        label = str(pkg.relative_to(project_root))
        try:
            scripts = json.loads((pkg / "package.json").read_text()).get("scripts", {})
        except (json.JSONDecodeError, OSError):
            scripts = {}
        script = next((n for n in ("check:light", "check") if n in scripts), None)
        if script:
            checks.append((f"{label} ({script})", ["pnpm", "run", script], pkg, 90))
        elif has_svelte_config(pkg):
            checks.append((f"{label} (svelte-check)", ["pnpm", "exec", "svelte-check", "--threshold", "error"], pkg, 90))
        elif (pkg / "tsconfig.json").exists():
            checks.append((f"{label} (tsc)", ["pnpm", "exec", "tsc", "--noEmit"], pkg, 90))
    return checks


def detect_checks(project_root: Path, changed: set[str] | None = None) -> list[Check]:
    """Return (name, command, cwd, timeout) tuples for applicable checks."""
    checks: list[Check] = []

    if changed and (project_root / "pnpm-workspace.yaml").exists():
        checks.extend(package_checks(project_root, changed))

    if not checks:
        if (project_root / "tsconfig.json").exists():
            checks.append(("TypeScript", ["pnpm", "tsc", "--noEmit"], project_root, 90))

        if has_svelte_config(project_root):
            checks.append(("Svelte", ["pnpm", "svelte-check", "--threshold", "error"], project_root, 90))

    if (project_root / "pyproject.toml").exists() or (project_root / "setup.py").exists():
        checks.append(("Python (mypy)", ["mypy", "."], project_root, 60))

    if (project_root / "Cargo.toml").exists():
        checks.append(("Rust", ["cargo", "check"], project_root, 120))

    return checks


# ── Running checks ───────────────────────────────────────────────────


def resolve_pnpm(cwd: Path) -> str | None:
    """Find pnpm even when it isn't on the PATH this hook inherits.

    mise only activates in interactive shells, so a pnpm installed under a
    mise-managed node is invisible here and every TS/Svelte check ended as
    "Command not found".
    """
    found = shutil.which("pnpm")
    if found:
        return found

    mise = shutil.which("mise")
    if mise:
        try:
            result = subprocess.run(
                [mise, "which", "pnpm"], cwd=cwd,
                capture_output=True, text=True, timeout=5,
            )
            candidate = result.stdout.strip()
            if result.returncode == 0 and candidate and Path(candidate).exists():
                return candidate
        except (subprocess.TimeoutExpired, OSError):
            pass

    installs = Path.home() / ".local" / "share" / "mise" / "installs" / "node"
    for version in ("latest", "lts"):
        candidate = installs / version / "bin" / "pnpm"
        if candidate.exists():
            return str(candidate)
    return None


def run_check(name: str, command: list[str], cwd: Path, timeout: int = 60) -> dict:
    """Run a single verification check."""
    env = None
    if command[0] == "pnpm":
        pnpm = resolve_pnpm(cwd)
        if pnpm is None:
            return {"name": name, "success": False, "error": "Command not found"}
        command = [pnpm, *command[1:]]
        # pnpm's launcher runs `node` from PATH; put its own bin dir first so it
        # gets the node it was installed with.
        env = {**os.environ, "PATH": f"{Path(pnpm).parent}{os.pathsep}{os.environ.get('PATH', '')}"}
    try:
        result = subprocess.run(
            command, cwd=cwd, env=env,
            capture_output=True, text=True, timeout=timeout,
        )
        return {
            "name": name,
            "cwd": cwd,
            "success": result.returncode == 0,
            "returncode": result.returncode,
            # Keep the HEAD of the output: tsc/svelte-check print the first
            # (most relevant) errors first, then a "Found N errors" trailer.
            # Tailing the output would drop the errors we actually want.
            "stdout": (result.stdout or "")[:16000],
            "stderr": (result.stderr or "")[:16000],
        }
    except subprocess.TimeoutExpired:
        return {"name": name, "success": False, "error": f"Timeout after {timeout}s"}
    except FileNotFoundError:
        return {"name": name, "success": False, "error": "Command not found"}
    except Exception as e:
        return {"name": name, "success": False, "error": str(e)}


# ── Verification output ─────────────────────────────────────────────


def check_detail(r: dict) -> str:
    """Human-useful error text for a failed check.

    tsc, svelte-check, and mypy write their diagnostics to stdout, so prefer
    stdout and fall back to stderr (where cargo and the pnpm wrapper write).
    The old code only ever read stderr, which is empty for the TS toolchain —
    that's why failures showed up as a bare "failed (exit 2)".
    """
    if r.get("error"):
        return r["error"].strip()
    return (r.get("stdout") or "").strip() or (r.get("stderr") or "").strip()


SUMMARY_LINES = 15


def format_results(results: list[dict]) -> str:
    """Compact summary: the verdict plus the first error lines per failed check."""
    if not results:
        return ""

    lines = ["", "📋 Verification Results:"]
    all_passed = True

    for r in results:
        if r["success"]:
            lines.append(f"  ✅ {r['name']}: passed")
            continue

        if r.get("pre_existing"):
            lines.append(f"  ⏭️  {r['name']}: pre-existing errors ignored (not in this turn's changes)")
            continue

        all_passed = False
        lines.append(f"  ❌ {r['name']}: failed (exit {r.get('returncode', '?')})")
        detail = check_detail(r)
        if not detail:
            continue
        detail_lines = detail.split("\n")
        lines.extend(f"       {dl}" for dl in detail_lines[:SUMMARY_LINES])
        if len(detail_lines) > SUMMARY_LINES:
            lines.append(f"       … ({len(detail_lines) - SUMMARY_LINES} more lines — see log)")

    if all_passed:
        lines.insert(1, "✨ All checks passed!")
    else:
        lines.insert(1, "⚠️  Some checks failed - review before committing")

    return "\n".join(lines)


def format_log(results: list[dict]) -> str:
    """Full detail for the persisted log: compact summary, then complete output."""
    if not results:
        return ""

    blocks = [format_results(results), "", "─" * 60, "FULL OUTPUT", "─" * 60]
    for r in results:
        if r["success"]:
            status = "passed"
        elif r.get("pre_existing"):
            status = f"FAILED (exit {r.get('returncode', '?')}) — pre-existing, ignored"
        else:
            status = f"FAILED (exit {r.get('returncode', '?')})"
        blocks.append(f"\n## {r['name']} — {status}")
        if r.get("error"):
            blocks.append(r["error"].strip())
        out = (r.get("stdout") or "").strip()
        err = (r.get("stderr") or "").strip()
        if out:
            blocks.append(out)
        if err:
            blocks.append("[stderr]")
            blocks.append(err)
        if not (r.get("error") or out or err):
            blocks.append("(no output)")
    return "\n".join(blocks)


# ── Background worker ───────────────────────────────────────────────


def send_notification(title: str, message: str) -> None:
    """Send a macOS notification via osascript."""
    try:
        subprocess.run(
            ["osascript", "-e", f'display notification "{message}" with title "{title}"'],
            timeout=5, capture_output=True,
        )
    except Exception:
        pass


def write_log(project_root: Path, output: str) -> Path | None:
    """Persist verification output so it can be read after the turn ends.

    Returns the absolute log path (or None if writing failed) so the
    notification can point at the real file instead of a relative string.
    """
    try:
        log_dir = project_root / ".claude" / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "last-verify.txt"
        log_path.write_text(output.strip() + "\n")
        return log_path
    except Exception:
        return None  # Background — never crash on logging


# Extensions whose changes warrant a type/lint pass.
CHECK_EXTENSIONS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".svelte", ".py", ".rs")


def get_changed_files(project_root: Path) -> set[str] | None:
    """Return staged/unstaged/untracked file paths, relative to project_root.

    None means git is unavailable or this isn't a repo — callers should fail
    open (don't suppress or filter checks) in that case.
    """
    try:
        result = subprocess.run(
            # -uall: without it a new folder shows as one "dir/" line and its
            # files are never seen as changed.
            ["git", "status", "--porcelain", "-uall"],
            cwd=project_root, capture_output=True, text=True, timeout=5,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None
    if result.returncode != 0:
        return None  # not a git repo

    changed = set()
    for line in result.stdout.strip().splitlines():
        path = line[3:]  # strip the "XY " porcelain status prefix
        if " -> " in path:  # rename: "old -> new"
            path = path.split(" -> ", 1)[1]
        changed.add(path.strip().strip('"'))
    return changed


def changed_files_need_checks(project_root: Path) -> bool:
    """True if uncommitted changes touch a checkable file.

    Avoids running a full monorepo typecheck after turns that changed nothing
    relevant (a Q&A turn, a markdown edit). Fails open: if git is unavailable,
    run the checks rather than silently skip them.
    """
    changed = get_changed_files(project_root)
    if changed is None:
        return True
    return any(path.endswith(CHECK_EXTENSIONS) for path in changed)


# Pull the offending file out of a compiler error line, per toolchain format:
#   tsc/svelte-check: "path/to/file.ts(12,34): error TS2305: ..."
#   mypy:              "path/to/file.py:12: error: ..."
#   cargo:             "  --> src/main.rs:12:34"
_ERROR_FILE_PATTERNS = (
    re.compile(r"^([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|svelte))\(\d+,\d+\):"),
    re.compile(r"^([\w./\\-]+\.py):\d+:"),
    re.compile(r"-->\s+([\w./\\-]+\.rs):\d+:\d+"),
)


def extract_error_files(output: str) -> set[str]:
    """Best-effort set of file paths mentioned in a check's error output."""
    files = set()
    for line in output.splitlines():
        line = line.strip()
        for pattern in _ERROR_FILE_PATTERNS:
            match = pattern.search(line)
            if match:
                files.add(match.group(1))
                break
    return files


STATE_DIR = Path.home() / ".claude" / ".cache"


def already_reported(project_root: Path, failed: list[dict]) -> bool:
    """True if these exact failures already woke Claude once. Records them if not.

    Waking Claude makes it stop again, which runs this hook again. Without this
    an error Claude cannot fix would wake it forever.
    """
    key = hashlib.sha1(str(project_root).encode()).hexdigest()[:16]
    state = STATE_DIR / f"stop-verify-{key}.sig"
    signature = hashlib.sha1(
        "\n".join(r["name"] + check_detail(r) for r in failed).encode()
    ).hexdigest()
    try:
        if not failed:
            state.unlink(missing_ok=True)
            return False
        if state.exists() and state.read_text() == signature:
            return True
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        state.write_text(signature)
    except OSError:
        pass
    return False


def do_work() -> str | None:
    """Run checks, persist results, and notify with pass/fail status.

    Returns the failure summary Claude should see, or None when there is
    nothing for it to fix.
    """
    project_root = find_project_root()

    # No project, no relevant edits, or no applicable checks — just confirm Claude stopped.
    if not project_root:
        send_notification("Claude", "Done ✓")
        return

    if not changed_files_need_checks(project_root):
        send_notification("Claude", "Done ✓")
        return

    changed_files = get_changed_files(project_root)
    checks = detect_checks(project_root, changed_files)
    if not checks:
        send_notification("Claude", "Done ✓")
        return

    results = [run_check(name, cmd, cwd, timeout) for name, cmd, cwd, timeout in checks]

    # Demote failures that live entirely in files this turn never touched —
    # a monorepo-wide check otherwise cries wolf on every turn once any file,
    # anywhere, has a pre-existing error. Fails open: only demote when we can
    # confidently attribute every reported error to an untouched file.
    if changed_files:
        for r in results:
            if r["success"]:
                continue
            # Compilers report paths relative to the check's cwd; git reports
            # them relative to the repo root.
            cwd = r.get("cwd", project_root)
            error_files = {
                os.path.relpath(cwd / f, project_root)
                for f in extract_error_files(check_detail(r))
            }
            if error_files and not (error_files & changed_files):
                r["pre_existing"] = True

    # The log file gets the FULL output; the printed summary is the short form.
    log_path = write_log(project_root, format_log(results))

    # Notification reflects the actual check status, not just "stopped".
    failed = [r for r in results if not r["success"] and not r.get("pre_existing")]
    if not failed:
        already_reported(project_root, [])
        send_notification("Claude", "Done ✓ — all checks passed")
        return None

    names = ", ".join(r["name"] for r in failed)
    where = f" — see {log_path}" if log_path else ""
    send_notification("Claude", f"❌ {names} failed{where}")

    # A check that could not run (missing tool, timeout) is not Claude's to fix.
    ran = [r for r in failed if "returncode" in r]
    if not ran or already_reported(project_root, ran):
        return None
    return format_results(results) + (f"\n\nFull output: {log_path}" if log_path else "")


# ── Main ─────────────────────────────────────────────────────────────


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        data = {}

    cwd = data.get("cwd") if isinstance(data, dict) else None
    if cwd and Path(cwd).is_dir():
        os.chdir(cwd)

    try:
        failure = do_work()
    except Exception:
        sys.exit(0)  # A hook must never crash the turn.

    if failure:
        print(
            "Checks failed after you stopped. Fix the errors in files you "
            "changed, or say why they are not yours:\n" + failure,
            file=sys.stderr,
        )
        sys.exit(2)  # exit 2 → asyncRewake wakes Claude with stderr
    sys.exit(0)


if __name__ == "__main__":
    main()
