#!/usr/bin/env python3
"""Fail closed when the Scene Engine 0.5 repository shape regresses."""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.5.0"

PYTHON_MODULES = {
    "__init__.py",
    "clock.py",
    "errors.py",
    "json_tree.py",
    "recording.py",
    "runtime.py",
    "scene.py",
    "session.py",
    "wire.py",
}
JAVASCRIPT_PACKAGES = {"client", "renderer-three"}
CURRENT_DOCS = {
    "architecture.md",
    "client.md",
    "cutover-report.md",
    "recording-replay.md",
    "runtime.md",
    "transform.md",
    "wire.md",
}
REQUIRED_FIXTURES = {
    "fixtures/transform-v1/rule-matrix.canonical-vectors.json",
    "fixtures/wire-v1/checkpoint.bin",
    "fixtures/wire-v1/commit-tick.bin",
    "fixtures/wire-v1/commit-input.bin",
    "js/packages/client/fixtures/packet-log/manifest.json",
    "js/packages/client/fixtures/packet-log/index.json",
    "js/packages/client/fixtures/packet-log/packets.bin",
    "js/packages/client/fixtures/packet-log/malformed/manifest.json",
    "js/packages/client/fixtures/packet-log/malformed/index.json",
    "js/packages/client/fixtures/packet-log/malformed/packets.bin",
}


def joined(*parts: str) -> str:
    return "".join(parts)


# Entries are split so this gate can scan its own source without an exclusion.
REMOVED_IDENTITIES = (
    joined(".engi", "neer/"),
    joined("mw-authority", "-state-v5"),
    joined("mw-display", "-command-v5"),
    joined("mw-v5-authority", "-cursor"),
    joined("scene-presentation", "-control-v2"),
    joined("scene-presentation", "-archive-v3"),
    joined("V5Runtime", "Application"),
    joined("V5State", "Stream"),
    joined("V5Intent", "Request"),
    joined("PresentationRuntime", "Bridge"),
    joined("PresentationCorrelation", "Coordinator"),
    joined("PresentationCorrelation", "Record"),
    joined("StateEpoch", "Mirror"),
    joined("createV5Business", "ProjectionStore"),
    joined("MwV5Authority", "Lane"),
    joined("CompositeReplay", "Session"),
    joined("OrderedPresentation", "Session"),
    joined("AuthorityCommit", "Callback"),
    joined("AuthorityCommit", "Request"),
    joined("PresentationExport", "Request"),
    joined("state", "_stream_id"),
    joined("state", "_epoch"),
    joined("previous", "_state_seq"),
    joined("correlation", "_seq"),
    joined("authority", "_cursor"),
    joined("scene", "_epoch"),
    joined("bootstrap", "_id"),
    joined("frame", "_seq"),
    joined("projection", "_id"),
    joined("0.4", ".0"),
)

TEXT_SUFFIXES = {".js", ".json", ".lock", ".md", ".mjs", ".py", ".toml"}
SKIPPED_DIRECTORY_NAMES = {
    ".git",
    ".pytest_cache",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def current_files(directory: Path) -> set[str]:
    return {path.name for path in directory.iterdir() if path.is_file()}


def iter_current_text_files():
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIPPED_DIRECTORY_NAMES for part in path.relative_to(ROOT).parts):
            continue
        if path.suffix in TEXT_SUFFIXES or path.name in {"AGENTS.md", "README.md"}:
            yield path


def verify_tree() -> None:
    require(
        current_files(ROOT / "src" / "scene_engine") == PYTHON_MODULES,
        "Python implementation module allowlist mismatch",
    )
    require(
        {path.name for path in (ROOT / "js" / "packages").iterdir() if path.is_dir()}
        == JAVASCRIPT_PACKAGES,
        "JavaScript package allowlist mismatch",
    )
    require(current_files(ROOT / "docs") == CURRENT_DOCS, "current docs allowlist mismatch")
    missing = sorted(path for path in REQUIRED_FIXTURES if not (ROOT / path).is_file())
    require(not missing, f"required fixtures missing: {missing}")


def verify_versions_and_graph() -> None:
    root_package = load_json(ROOT / "package.json")
    lock = load_json(ROOT / "package-lock.json")
    client = load_json(ROOT / "js" / "packages" / "client" / "package.json")
    renderer = load_json(ROOT / "js" / "packages" / "renderer-three" / "package.json")
    require(root_package.get("version") == VERSION, "root npm version mismatch")
    require(lock.get("version") == VERSION, "npm lock version mismatch")
    require(client.get("name") == "@scene-engine/client", "client package identity mismatch")
    require(renderer.get("name") == "@scene-engine/renderer-three", "renderer identity mismatch")
    require(client.get("version") == VERSION, "client package version mismatch")
    require(renderer.get("version") == VERSION, "renderer package version mismatch")
    graph = {
        key
        for key in lock.get("packages", {})
        if key.startswith("js/packages/")
    }
    require(
        graph == {"js/packages/client", "js/packages/renderer-three"},
        "npm workspace graph contains a removed package",
    )
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    require(f'version = "{VERSION}"' in pyproject, "Python project version mismatch")
    require('requires-python = ">=3.10"' in pyproject, "Python floor mismatch")
    require(f'version = "{VERSION}"' in (ROOT / "uv.lock").read_text(encoding="utf-8"),
            "Python lock version mismatch")


def verify_fixtures() -> None:
    transform = load_json(
        ROOT / "fixtures" / "transform-v1" / "rule-matrix.canonical-vectors.json"
    )
    require(transform.get("contract_ref") == "scene-engine-transform@1",
            "transform contract identity mismatch")
    require(transform.get("encoding") == "scene-engine-transform@1",
            "transform encoding identity mismatch")
    manifest = load_json(
        ROOT / "js" / "packages" / "client" / "fixtures" / "packet-log" / "manifest.json"
    )
    require(manifest.get("schema") == "scene-engine-packet-log@1",
            "packet-log fixture identity mismatch")
    require(manifest.get("checkpoint_count", 0) >= 2,
            "packet-log fixture must include a periodic checkpoint")


def verify_removed_content() -> None:
    findings: list[str] = []
    for path in iter_current_text_files():
        text = path.read_text(encoding="utf-8")
        for identity in REMOVED_IDENTITIES:
            if identity in text:
                findings.append(f"{path.relative_to(ROOT)}: {identity}")
    require(not findings, "removed identity remains:\n" + "\n".join(findings))


def main() -> int:
    try:
        verify_tree()
        verify_versions_and_graph()
        verify_fixtures()
        verify_removed_content()
    except (AssertionError, OSError, ValueError) as exc:
        print(f"cutover verification failed: {exc}", file=sys.stderr)
        return 1
    print("scene-engine 0.5 cutover verification passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
