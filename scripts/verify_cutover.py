#!/usr/bin/env python3
"""Fail closed when the Scene Engine core 0.6 / renderer 0.8 V2 cutover regresses."""

from __future__ import annotations

import base64
import hashlib
import inspect
import json
import re
import sys
import tarfile
import zipfile
from dataclasses import fields
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
JS_CORE_VERSION = "0.6.0"
PYTHON_VERSION = "0.6.1"
RENDERER_VERSION = "0.8.0"
RENDERER_ARTIFACT = f"scene-engine-renderer-three-{RENDERER_VERSION}.tgz"
THREE_RANGE = "^0.181.2"
THREE_LOCKED_VERSION = "0.181.2"

RENDER_SCHEMAS = {
    "THREE_RENDER_RUNTIME_SCHEMA": "scene-engine-three-render-runtime@2",
    "RENDER_RESOURCE_CATALOG_SCHEMA": "scene-engine-render-resource-catalog@2",
    "RENDER_COMPOSITION_SCHEMA": "scene-engine-render-composition@2",
    "RENDER_SNAPSHOT_SCHEMA": "scene-engine-render-snapshot@2",
    "RENDER_BATCH_SCHEMA": "scene-engine-render-batch@2",
}
PIPELINE_IDS = (
    "model@2",
    "sprite@2",
    "surface@2",
    "particle@2",
    "scene-pass@2",
)
RENDERER_ROOT_EXPORTS = {
    "THREE_RENDER_RUNTIME_SCHEMA",
    "RENDER_COMPOSITION_SCHEMA",
    "RENDER_SNAPSHOT_SCHEMA",
    "RENDER_BATCH_SCHEMA",
    "ThreeRenderRuntimeError",
    "ThreeRenderRuntime",
    "createThreeRenderRuntime",
}

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
    "python-static-dynamic-cutover-report.md",
    "recording-replay.md",
    "render-runtime.md",
    "runtime.md",
    "transform.md",
    "wire.md",
}
CURRENT_NORMATIVE_DOCUMENTS = (
    ROOT / "README.md",
    ROOT / "AGENTS.md",
    *(ROOT / "docs" / name for name in sorted(CURRENT_DOCS)),
)
ARTS_NORMATIVE_PATHS = (
    "README.md",
    "AGENTS.md",
    "docs/README.md",
    "docs/architecture/target7-display-layer-architecture-target.md",
    "docs/art-requirements-execution-plan.md",
    "docs/render-runtime-cutover-report.md",
    "docs/migration/target7-scene-tool-inventory.md",
    "web3d/README.md",
    "web3d/RESOURCE_OWNERSHIP.md",
    "packages/display-runtime/README.md",
    "packages/display-sdk/README.md",
)
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


# Entries are split so the gate can scan its own source without an exclusion.
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

SUPERSEDED_RENDER_IDENTITIES = (
    joined("@scene-engine/renderer-three@", "0.6.0"),
    joined("scene-engine-renderer-three-", "0.6.0.tgz"),
    joined("@scene-engine/renderer-three@", "0.7.0"),
    joined("scene-engine-renderer-three-", "0.7.0.tgz"),
    *(f"{value[:-1]}1" for value in RENDER_SCHEMAS.values()),
    *(f"{pipeline[:-1]}1" for pipeline in PIPELINE_IDS),
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
HISTORICAL_DIRECTORY_NAMES = {"archive", "archives", "history", "historical"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def current_files(directory: Path) -> set[str]:
    return {path.name for path in directory.iterdir() if path.is_file()}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha512_integrity(path: Path) -> str:
    digest = hashlib.sha512(path.read_bytes()).digest()
    return "sha512-" + base64.b64encode(digest).decode("ascii")


def tree_sha256(directory: Path) -> str:
    require(directory.is_dir(), f"required build directory missing: {directory}")
    digest = hashlib.sha256()
    files = sorted(path for path in directory.rglob("*") if path.is_file())
    require(files, f"required build directory is empty: {directory}")
    for path in files:
        relative = path.relative_to(directory).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        data = path.read_bytes()
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return digest.hexdigest()


def is_historical(path: Path) -> bool:
    relative = path.relative_to(ROOT)
    if any(part.lower() in HISTORICAL_DIRECTORY_NAMES for part in relative.parts):
        return True
    if relative.parts[:2] == ("docs", "migration"):
        return True
    if path.suffix == ".md":
        heading = "\n".join(path.read_text(encoding="utf-8").splitlines()[:12]).lower()
        return "historical evidence" in heading or "历史证据" in heading
    return False


def iter_current_text_files():
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(ROOT)
        if any(part in SKIPPED_DIRECTORY_NAMES for part in relative.parts):
            continue
        if is_historical(path):
            continue
        if path.suffix in TEXT_SUFFIXES or path.name in {"AGENTS.md", "README.md"}:
            yield path


def arts_current_normative_documents(arts: Path) -> tuple[Path, ...]:
    if not arts.is_dir():
        return ()
    documents = {arts / relative for relative in ARTS_NORMATIVE_PATHS}
    for pattern in (
        "docs/art-execution-rules/current/**/*.md",
        "code/*/*/README.md",
        "packages/display-runtime/docs/*.md",
        "resources/*/*/README.md",
        "resources/*/*/CURRENT_STATUS.md",
        "resources/*/*/current-resources.md",
    ):
        documents.update(arts.glob(pattern))
    missing = sorted(path.relative_to(arts).as_posix() for path in documents if not path.is_file())
    require(not missing, f"required Arts current documents are missing: {missing}")
    return tuple(sorted(documents))


def arts_production_text_files(arts: Path):
    if not arts.is_dir():
        return
    for root_name in ("web3d/src", "code", "packages"):
        root = arts / root_name
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in TEXT_SUFFIXES:
                continue
            relative = path.relative_to(arts)
            lowered = {part.lower() for part in relative.parts}
            if lowered & {
                "archive",
                "archives",
                "dist",
                "fixtures",
                "history",
                "historical",
                "node_modules",
                "review",
                "tests",
                "vendor",
            }:
                continue
            if ".test." in path.name:
                continue
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
    require(
        (ROOT / "scripts" / "benchmark_scene_500.py").is_file(),
        "strict 500-node benchmark entry is missing",
    )
    require(
        not (ROOT / "scripts" / "benchmark_scene_publication.py").exists(),
        "superseded benchmark entry remains",
    )


def verify_versions_and_graph() -> None:
    root_package = load_json(ROOT / "package.json")
    lock = load_json(ROOT / "package-lock.json")
    client = load_json(ROOT / "js" / "packages" / "client" / "package.json")
    renderer = load_json(ROOT / "js" / "packages" / "renderer-three" / "package.json")
    require(
        root_package.get("version") == JS_CORE_VERSION,
        "root npm version mismatch",
    )
    require(lock.get("version") == JS_CORE_VERSION, "npm lock version mismatch")
    require(client.get("name") == "@scene-engine/client", "client package identity mismatch")
    require(renderer.get("name") == "@scene-engine/renderer-three", "renderer identity mismatch")
    require(
        client.get("version") == JS_CORE_VERSION,
        "client package version mismatch",
    )
    require(renderer.get("version") == RENDERER_VERSION, "renderer package version mismatch")
    require(
        renderer.get("dependencies", {}).get("three") == THREE_RANGE,
        "renderer must own the exact Three runtime dependency range",
    )
    require(
        "three" not in renderer.get("peerDependencies", {}),
        "renderer must not delegate Three ownership to callers",
    )
    graph = {key for key in lock.get("packages", {}) if key.startswith("js/packages/")}
    require(
        graph == {"js/packages/client", "js/packages/renderer-three"},
        "npm workspace graph contains a removed package",
    )
    locked_renderer = lock.get("packages", {}).get("js/packages/renderer-three", {})
    require(locked_renderer.get("version") == RENDERER_VERSION, "renderer lock version mismatch")
    require(
        locked_renderer.get("dependencies", {}).get("three") == THREE_RANGE,
        "renderer lock Three range mismatch",
    )
    locked_three = lock.get("packages", {}).get("node_modules/three", {})
    require(
        locked_three.get("version") == THREE_LOCKED_VERSION,
        "resolved Three version mismatch",
    )
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    require(
        f'version = "{PYTHON_VERSION}"' in pyproject,
        "Python project version mismatch",
    )
    require('requires-python = ">=3.10"' in pyproject, "Python floor mismatch")
    require(
        f'version = "{PYTHON_VERSION}"'
        in (ROOT / "uv.lock").read_text(encoding="utf-8"),
        "Python lock version mismatch",
    )


def verify_renderer_v2_contract_identity() -> None:
    source_root = ROOT / "js" / "packages" / "renderer-three" / "src"
    constants = (source_root / "constants.js").read_text(encoding="utf-8")
    for name, identity in RENDER_SCHEMAS.items():
        require(
            f"export const {name} = '{identity}';" in constants,
            f"renderer schema identity mismatch: {name}",
        )
    pipeline_match = re.search(
        r"export const PIPELINE_IDS\s*=\s*Object\.freeze\(\[(.*?)\]\);",
        constants,
        re.DOTALL,
    )
    require(pipeline_match is not None, "renderer pipeline allowlist is missing")
    actual_pipelines = tuple(re.findall(r"'([^']+)'", pipeline_match.group(1)))
    require(actual_pipelines == PIPELINE_IDS, "renderer pipeline allowlist mismatch")
    require("'node-composition'" in constants, "node-composition scope identity missing")
    require("'scene-layers'" in constants, "scene-layers scope identity missing")

    index = (source_root / "index.js").read_text(encoding="utf-8")
    exported: set[str] = set()
    for block in re.findall(r"export\s*\{(.*?)\}\s*from", index, re.DOTALL):
        for item in block.split(","):
            item = item.strip()
            if not item:
                continue
            exported.add(item.split(" as ")[-1].strip())
    require(exported == RENDERER_ROOT_EXPORTS, "renderer package root export allowlist mismatch")

    production_text = "\n".join(
        path.read_text(encoding="utf-8") for path in sorted(source_root.glob("*.js"))
    )
    stale = [identity for identity in SUPERSEDED_RENDER_IDENTITIES if identity in production_text]
    require(not stale, f"renderer production source contains superseded identities: {stale}")
    require(
        "WebGLRenderTarget" not in production_text,
        "renderer production source still claims or creates a WebGLRenderTarget",
    )


def verify_fixtures() -> None:
    transform = load_json(
        ROOT / "fixtures" / "transform-v1" / "rule-matrix.canonical-vectors.json"
    )
    require(
        transform.get("contract_ref") == "scene-engine-transform@1",
        "transform contract identity mismatch",
    )
    require(
        transform.get("encoding") == "scene-engine-transform@1",
        "transform encoding identity mismatch",
    )
    manifest = load_json(
        ROOT / "js" / "packages" / "client" / "fixtures" / "packet-log" / "manifest.json"
    )
    require(
        manifest.get("schema") == "scene-engine-packet-log@1",
        "packet-log fixture identity mismatch",
    )
    require(
        manifest.get("checkpoint_count", 0) >= 2,
        "packet-log fixture must include a periodic checkpoint",
    )


def verify_python_contract() -> None:
    sys.path.insert(0, str(ROOT / "src"))
    import scene_engine
    from scene_engine.runtime import ProductCheckpoint, ProductCommit
    from scene_engine.wire import AttachmentKind, encode_commit, read_engine_packet

    require(
        scene_engine.__version__ == PYTHON_VERSION,
        "Python import version mismatch",
    )
    require(
        [field.name for field in fields(ProductCheckpoint)]
        == [
            "world_codec",
            "world_snapshot",
            "scene_bootstrap",
            "scene_nodes",
            "scene_events",
        ],
        "ProductCheckpoint product port mismatch",
    )
    require(
        [field.name for field in fields(ProductCommit)]
        == ["world_codec", "world_patch", "scene_nodes", "scene_events"],
        "ProductCommit product port mismatch",
    )
    require(
        "events" not in inspect.signature(encode_commit).parameters,
        "independent product events encoder remains",
    )
    require(5 not in {int(kind) for kind in AttachmentKind}, "removed attachment kind 5 remains")
    packet = read_engine_packet(
        ROOT.joinpath("fixtures", "wire-v1", "commit-tick.bin").read_bytes()
    )
    require(
        [int(item.kind) for item in packet.attachments] == [2, 4],
        "tick fixture does not use the 0.6 commit layout",
    )


def verify_python_patch_release() -> None:
    scene_evidence = ROOT / "docs" / "evidence" / "python-static-dynamic-500.json"
    require(scene_evidence.is_file(), "Python 0.6.1 Scene evidence is missing")
    scene_report = load_json(scene_evidence)
    scene_parameters = scene_report.get("parameters", {})
    require(
        scene_report.get("runtime", {}).get("scene_engine_version")
        == PYTHON_VERSION,
        "Scene evidence Python version mismatch",
    )
    require(
        scene_parameters.get("benchmark_mode") == "formal"
        and scene_parameters.get("warmup_per_round", 0) >= 60
        and scene_parameters.get("samples_per_round", 0) >= 600
        and scene_parameters.get("rounds", 0) >= 5,
        "Scene evidence is not a formal-sized run",
    )
    require(
        scene_report.get("performance_gates", {}).get("overall_passed") is True,
        "Scene evidence performance gates did not pass",
    )

    python_game = WORKSPACE / "python-game"
    if not python_game.is_dir():
        return
    product_evidence = (
        python_game
        / "docs"
        / "evidence"
        / "python-runtime-static-dynamic-500.json"
    )
    require(product_evidence.is_file(), "Python Game 0.6.1 evidence is missing")
    product_report = load_json(product_evidence)
    product_parameters = product_report.get("parameters", {})
    require(
        product_report.get("runtime", {}).get("scene_engine_version")
        == PYTHON_VERSION,
        "Python Game evidence Scene Engine version mismatch",
    )
    require(
        product_parameters.get("warmup_per_round", 0) >= 60
        and product_parameters.get("samples_per_round", 0) >= 600
        and product_parameters.get("rounds", 0) >= 5
        and product_parameters.get("runtime_ack_commits", 0) >= 600
        and product_parameters.get("soak_commits", 0) >= 3600,
        "Python Game evidence is not a formal-sized run",
    )
    require(
        product_report.get("acceptance_gates", {}).get("mode") == "formal"
        and product_report.get("acceptance_gates", {}).get("overall_passed")
        is True,
        "Python Game evidence acceptance gates did not pass",
    )

    project = (python_game / "pyproject.toml").read_text(encoding="utf-8")
    project_block = project.split("[project]", 1)[1].split("\n[", 1)[0]
    require(
        f'version = "{PYTHON_VERSION}"' in project_block,
        "Python Game project version mismatch",
    )
    require(
        f'dependencies = ["scene-engine=={PYTHON_VERSION}"]' in project_block,
        "Python Game Scene Engine dependency mismatch",
    )
    expected_wheel = (
        python_game
        / "vendor"
        / f"scene_engine-{PYTHON_VERSION}-py3-none-any.whl"
    )
    wheels = sorted((python_game / "vendor").glob("scene_engine-*.whl"))
    require(wheels == [expected_wheel], "Python Game vendor wheel tuple mismatch")
    wheel_sha256 = sha256_file(expected_wheel)
    lock_lines = (python_game / "requirements.lock").read_text(
        encoding="utf-8"
    ).splitlines()
    require(
        lock_lines
        == [
            "--find-links ./vendor",
            f"scene-engine=={PYTHON_VERSION} --hash=sha256:{wheel_sha256}",
        ],
        "Python Game requirements lock does not match the vendor wheel",
    )
    with zipfile.ZipFile(expected_wheel) as archive:
        metadata = archive.read(
            f"scene_engine-{PYTHON_VERSION}.dist-info/METADATA"
        ).decode("utf-8")
        package_init = archive.read("scene_engine/__init__.py").decode("utf-8")
    require(
        f"\nVersion: {PYTHON_VERSION}\n" in f"\n{metadata}",
        "vendor wheel metadata version mismatch",
    )
    require(
        f'__version__ = "{PYTHON_VERSION}"' in package_init,
        "vendor wheel import version mismatch",
    )

    scene_sha256 = sha256_file(scene_evidence)
    product_sha256 = sha256_file(product_evidence)
    release_reports = (
        ROOT / "docs" / "python-static-dynamic-cutover-report.md",
        python_game / "docs" / "python-static-dynamic-cutover-report.md",
    )
    for report_path in release_reports:
        require(report_path.is_file(), f"Python release report missing: {report_path}")
        release_text = report_path.read_text(encoding="utf-8")
        required = (
            f"scene-engine=={PYTHON_VERSION}",
            scene_evidence.name,
            product_evidence.name,
            scene_sha256,
            product_sha256,
            wheel_sha256,
            "Release decision: READY",
            "Known issues: zero",
        )
        missing = [identity for identity in required if identity not in release_text]
        require(
            not missing,
            f"Python release report evidence mismatch: {report_path}: {missing}",
        )

    historical_markers = (
        (
            ROOT / "docs" / "evidence" / "README.md",
            "scene-engine-500.json",
        ),
        (
            python_game / "docs" / "evidence" / "README.md",
            "runtime-500.json",
        ),
    )
    for marker_path, legacy_name in historical_markers:
        require(marker_path.is_file(), f"evidence index missing: {marker_path}")
        marker = marker_path.read_text(encoding="utf-8").lower()
        require(
            legacy_name in marker and "historical" in marker,
            f"legacy evidence is not marked historical: {legacy_name}",
        )


def verify_renderer_artifact() -> tuple[Path, str]:
    dist = ROOT / "dist"
    artifacts = sorted(dist.glob("scene-engine-renderer-three-*.tgz"))
    expected = dist / RENDERER_ARTIFACT
    require(artifacts == [expected], f"renderer dist tuple is not atomic: {artifacts}")

    source_root = ROOT / "js" / "packages" / "renderer-three"
    with tarfile.open(expected, mode="r:gz") as archive:
        package_json = json.loads(archive.extractfile("package/package.json").read())
        require(package_json.get("name") == "@scene-engine/renderer-three", "artifact name mismatch")
        require(package_json.get("version") == RENDERER_VERSION, "artifact version mismatch")
        require(
            package_json.get("dependencies", {}).get("three") == THREE_RANGE,
            "artifact Three dependency mismatch",
        )
        packed_sources = {
            member.name.removeprefix("package/"): member
            for member in archive.getmembers()
            if member.isfile() and member.name.startswith("package/src/")
        }
        worktree_sources = {
            path.relative_to(source_root).as_posix(): path
            for path in (source_root / "src").rglob("*")
            if path.is_file()
        }
        require(
            set(packed_sources) == set(worktree_sources),
            "artifact source file set does not match the renderer worktree",
        )
        for relative, path in worktree_sources.items():
            packed = archive.extractfile(packed_sources[relative]).read()
            require(packed == path.read_bytes(), f"artifact source is stale: {relative}")

    return expected, sha256_file(expected)


def verify_atomic_arts_consumer(artifact: Path, artifact_sha256: str) -> tuple[str, str | None]:
    arts = WORKSPACE / "arts"
    if not arts.is_dir():
        return "", None

    vendor = arts / "vendor"
    vendor_artifacts = sorted(vendor.glob("scene-engine-renderer-three-*.tgz"))
    expected_vendor = vendor / RENDERER_ARTIFACT
    require(
        vendor_artifacts == [expected_vendor],
        f"Arts renderer vendor tuple is not atomic: {vendor_artifacts}",
    )
    require(
        artifact.read_bytes() == expected_vendor.read_bytes(),
        "Scene Engine dist and Arts vendor renderer artifacts differ",
    )

    web_package = load_json(arts / "web3d" / "package.json")
    expected_dependency = f"file:../vendor/{RENDERER_ARTIFACT}"
    require(
        web_package.get("dependencies", {}).get("@scene-engine/renderer-three")
        == expected_dependency,
        "Arts web3d renderer dependency is not the 0.8 vendor artifact",
    )
    lock_path = arts / "package-lock.json"
    lock = load_json(lock_path)
    require(
        lock.get("packages", {}).get("web3d", {}).get("dependencies", {}).get(
            "@scene-engine/renderer-three"
        )
        == expected_dependency,
        "Arts lock web3d renderer dependency mismatch",
    )
    installed = lock.get("packages", {}).get("node_modules/@scene-engine/renderer-three", {})
    require(installed.get("version") == RENDERER_VERSION, "Arts lock renderer version mismatch")
    require(
        installed.get("resolved") == f"file:vendor/{RENDERER_ARTIFACT}",
        "Arts lock renderer resolved artifact mismatch",
    )
    require(
        installed.get("integrity") == sha512_integrity(expected_vendor),
        "Arts lock renderer integrity does not match vendor bytes",
    )

    arts_report = (arts / "docs" / "render-runtime-cutover-report.md").read_text(encoding="utf-8")
    required_report_identities = (
        f"@scene-engine/renderer-three                {RENDERER_VERSION}",
        RENDERER_ARTIFACT,
        *RENDER_SCHEMAS.values(),
        *PIPELINE_IDS,
    )
    missing_report_identities = [
        identity for identity in required_report_identities if identity not in arts_report
    ]
    require(
        not missing_report_identities,
        f"Arts cutover report identities are incomplete: {missing_report_identities}",
    )
    arts_lock_sha256 = sha256_file(lock_path)
    build_hash = tree_sha256(arts / "dist") if (arts / "dist").is_dir() else None
    require(build_hash is not None, "Arts production build directory is missing")
    missing_evidence = [
        f"renderer_sha256={artifact_sha256}" if artifact_sha256 not in arts_report else "",
        f"arts_lock_sha256={arts_lock_sha256}" if arts_lock_sha256 not in arts_report else "",
        f"arts_build_sha256={build_hash}" if build_hash not in arts_report else "",
    ]
    missing_evidence = [item for item in missing_evidence if item]
    require(
        not missing_evidence,
        "Arts cutover report evidence mismatch: " + ", ".join(missing_evidence),
    )
    require("PENDING_FINAL_" not in arts_report, "Arts cutover report still contains final placeholders")
    require("NOT RELEASE EVIDENCE" not in arts_report, "Arts cutover report is not release evidence")
    require(
        "Only after every final gate" not in arts_report,
        "Arts cutover report still contains worksheet instructions",
    )
    require("Release decision: READY" in arts_report, "Arts cutover report has no ready decision")
    require("Known issues: zero" in arts_report, "Arts cutover report has unresolved issues")
    return arts_lock_sha256, build_hash


def verify_current_document_identities() -> None:
    findings: list[str] = []
    documents = CURRENT_NORMATIVE_DOCUMENTS + arts_current_normative_documents(
        WORKSPACE / "arts"
    )
    for path in documents:
        text = path.read_text(encoding="utf-8")
        for identity in SUPERSEDED_RENDER_IDENTITIES:
            if identity in text:
                findings.append(f"{path.relative_to(WORKSPACE)}: {identity}")
    require(not findings, "current docs contain superseded render identities:\n" + "\n".join(findings))

    for path in arts_production_text_files(WORKSPACE / "arts"):
        text = path.read_text(encoding="utf-8")
        for identity in SUPERSEDED_RENDER_IDENTITIES:
            if identity in text:
                findings.append(f"{path.relative_to(WORKSPACE)}: {identity}")
    require(
        not findings,
        "Arts production graph contains superseded render identities:\n" + "\n".join(findings),
    )

    renderer_doc = (ROOT / "docs" / "render-runtime.md").read_text(encoding="utf-8")
    required_statements = (
        f"@scene-engine/renderer-three@{RENDERER_VERSION}",
        *RENDER_SCHEMAS.values(),
        *PIPELINE_IDS,
        "projection: 'perspective'",
        "alphaMode",
        "surface.standard|surface.water",
        "background|lights",
        "WebGLRenderTarget",
        "onHealth",
        "rebuild",
        "node-composition",
        "scene-layers",
    )
    missing = [statement for statement in required_statements if statement not in renderer_doc]
    require(not missing, f"renderer normative contract is incomplete: {missing}")


def verify_markdown_links() -> None:
    broken: list[str] = []
    link_pattern = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
    documents = CURRENT_NORMATIVE_DOCUMENTS + arts_current_normative_documents(
        WORKSPACE / "arts"
    )
    for path in documents:
        text = path.read_text(encoding="utf-8")
        for target in link_pattern.findall(text):
            target = target.strip().strip("<>")
            if not target or target.startswith(("#", "http://", "https://", "mailto:")):
                continue
            relative = target.split("#", 1)[0]
            if not relative:
                continue
            resolved = (path.parent / relative).resolve()
            if not resolved.exists():
                broken.append(f"{path.relative_to(WORKSPACE)} -> {target}")
    require(not broken, "current documentation has broken local links:\n" + "\n".join(broken))


def verify_removed_content() -> None:
    findings: list[str] = []
    for path in iter_current_text_files():
        text = path.read_text(encoding="utf-8")
        for identity in REMOVED_IDENTITIES:
            if identity in text:
                findings.append(f"{path.relative_to(ROOT)}: {identity}")
    require(not findings, "removed identity remains:\n" + "\n".join(findings))
    renderer_source = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (ROOT / "js" / "packages" / "renderer-three" / "src").glob("*.js")
    )
    for parts in (
        ("ThreeScene", "Backend"),
        ("createThreeScene", "Backend"),
        ("THREE_SCENE_", "BACKEND_SCHEMA"),
        ("resolve", "Factory"),
        ("handle.", "object3d"),
    ):
        identity = joined(*parts)
        require(identity not in renderer_source, f"removed renderer identity remains: {identity}")


def verify_release_report(
    artifact_sha256: str,
    arts_lock_sha256: str,
    arts_build_sha256: str | None,
) -> None:
    report = (ROOT / "docs" / "cutover-report.md").read_text(encoding="utf-8")
    required = (
        f"@scene-engine/renderer-three                {RENDERER_VERSION}",
        RENDERER_ARTIFACT,
        *RENDER_SCHEMAS.values(),
        *PIPELINE_IDS,
        artifact_sha256,
        sha256_file(ROOT / "package-lock.json"),
        "Release decision: READY",
        "Known issues: zero",
    )
    if arts_lock_sha256:
        required += (arts_lock_sha256,)
    if arts_build_sha256:
        required += (arts_build_sha256,)
    missing = [identity for identity in required if identity not in report]
    require(not missing, f"cutover report is incomplete or inconsistent: {missing}")
    require("PENDING_FINAL_" not in report, "cutover report still contains final placeholders")
    require("NOT RELEASE EVIDENCE" not in report, "cutover report is not release evidence")
    require(
        "Only after every final gate" not in report,
        "cutover report still contains worksheet instructions",
    )


def main() -> int:
    try:
        require(
            sys.version_info >= (3, 10),
            "Python >=3.10 is required; use the repository's `uv run python` environment",
        )
        verify_tree()
        verify_versions_and_graph()
        verify_renderer_v2_contract_identity()
        verify_fixtures()
        verify_python_contract()
        verify_python_patch_release()
        verify_current_document_identities()
        verify_markdown_links()
        verify_removed_content()
        artifact, artifact_sha256 = verify_renderer_artifact()
        arts_lock_sha256, arts_build_sha256 = verify_atomic_arts_consumer(
            artifact, artifact_sha256
        )
        verify_release_report(artifact_sha256, arts_lock_sha256, arts_build_sha256)
    except (AssertionError, OSError, ValueError, tarfile.TarError) as exc:
        print(f"cutover verification failed: {exc}", file=sys.stderr)
        return 1
    print("scene-engine core 0.6 / renderer 0.8 V2 cutover verification passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
