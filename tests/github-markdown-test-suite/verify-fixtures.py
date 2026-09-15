#!/usr/bin/env python3
"""Check that the pristine fixture package matches its SHA-256 manifest.

This does not test the user's extension, formatter semantics, or GitHub rendering.
Use on the original unpacked package, not on intentionally edited test files.
"""
from __future__ import annotations
import hashlib
import json
import sys
from pathlib import Path

def main() -> int:
    root = Path(__file__).resolve().parent
    manifest_path = root / "MANIFEST.sha256.json"
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"ERROR: cannot load manifest: {exc}", file=sys.stderr)
        return 2
    failures = []
    for relative, expected in data["files"].items():
        candidate = (root / relative).resolve()
        if root not in candidate.parents:
            failures.append(f"unsafe manifest path: {relative}")
            continue
        try:
            actual = hashlib.sha256(candidate.read_bytes()).hexdigest()
        except OSError as exc:
            failures.append(f"{relative}: {exc}")
            continue
        if actual != expected:
            failures.append(f"changed: {relative}")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print(f'PASS: {len(data["files"])} pristine fixture files match the manifest.')
    print("This is an integrity check, not an editor or GitHub compatibility test.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
