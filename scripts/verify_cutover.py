#!/usr/bin/env python3
"""Fail-closed verification for the Display repair and Showcase cutover."""

from __future__ import annotations

import base64
import hashlib
import json
import re
import stat
import sys
import tarfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
sys.path.insert(0, str(ROOT / "src"))

import scene_engine  # noqa: E402
from scene_engine.display import (  # noqa: E402
    DISPLAY_CHECKPOINT_SCHEMA,
    DISPLAY_CODEC,
    DISPLAY_COMMAND_SCHEMA,
    DISPLAY_COMMAND_STREAM_SCHEMA,
)
from scene_engine.recording import PACKET_LOG_SCHEMA  # noqa: E402
from scene_engine.wire import WIRE_SCHEMA, read_engine_packet  # noqa: E402


VERSIONS = {
    "python": "0.8.0",
    "client": "0.9.0",
    "display": "0.3.0",
    "renderer": "0.9.2",
}
ARTIFACTS = (
    f"scene-engine-client-{VERSIONS['client']}.tgz",
    f"scene-engine-display-{VERSIONS['display']}.tgz",
    f"scene-engine-renderer-three-{VERSIONS['renderer']}.tgz",
)
PACKAGE_ARTIFACTS = {
    "@scene-engine/client": (
        ROOT / "js/packages/client",
        ARTIFACTS[0],
        VERSIONS["client"],
    ),
    "@scene-engine/display": (
        ROOT / "js/packages/display",
        ARTIFACTS[1],
        VERSIONS["display"],
    ),
    "@scene-engine/renderer-three": (
        ROOT / "js/packages/renderer-three",
        ARTIFACTS[2],
        VERSIONS["renderer"],
    ),
}
REMOVED_ARTS_PACKAGES = tuple(
    "display-" + suffix for suffix in ("core", "runtime", "sdk", "baseline")
)
STALE = (
    "ThreeRender" + "Runtime",
    "Render" + "Composition",
    "Render" + "Snapshot",
    "Render" + "Batch",
    "Transform" + "Node",
    "Scene" + "Host",
    *REMOVED_ARTS_PACKAGES,
)


def require(condition: Any, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def package(path: Path, *, name: str, version: str) -> dict[str, Any]:
    value = read_json(path)
    require(value.get("name") == name, f"package name mismatch: {path}")
    require(value.get("version") == version, f"package version mismatch: {path}")
    return value


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def npm_sha512_integrity(path: Path) -> str:
    """Return the exact Subresource Integrity value written by npm lockfiles."""

    digest = hashlib.sha512(path.read_bytes()).digest()
    return "sha512-" + base64.b64encode(digest).decode("ascii")


def package_tarball_files(path: Path) -> dict[str, bytes]:
    """Read a closed npm package archive without extracting it to the filesystem."""

    require(path.is_file(), f"npm artifact missing: {path}")
    files: dict[str, bytes] = {}
    try:
        with tarfile.open(path, mode="r:gz") as archive:
            for member in archive.getmembers():
                require(
                    not (member.issym() or member.islnk()),
                    f"npm artifact contains link entry: {path}: {member.name}",
                )
                if not member.isfile():
                    continue
                member_path = PurePosixPath(member.name)
                require(
                    len(member_path.parts) >= 2
                    and member_path.parts[0] == "package"
                    and ".." not in member_path.parts,
                    f"npm artifact contains unsafe entry: {path}: {member.name}",
                )
                relative = PurePosixPath(*member_path.parts[1:]).as_posix()
                require(relative not in files, f"npm artifact contains duplicate entry: {path}: {relative}")
                extracted = archive.extractfile(member)
                require(extracted is not None, f"cannot read npm artifact entry: {path}: {relative}")
                files[relative] = extracted.read()
    except tarfile.TarError as error:
        raise AssertionError(f"invalid npm artifact: {path}: {error}") from error
    require(files, f"npm artifact contains no package files: {path}")
    return files


def source_package_files(package_root: Path) -> dict[str, bytes]:
    """Resolve the deliberately simple npm `files` allowlist used by Engine packages."""

    manifest_path = package_root / "package.json"
    manifest = read_json(manifest_path)
    allowlist = manifest.get("files")
    require(
        isinstance(allowlist, list) and allowlist,
        f"Engine package must have a non-empty files allowlist: {manifest_path}",
    )
    paths = {manifest_path}
    for entry in allowlist:
        require(
            isinstance(entry, str)
            and entry
            and not any(character in entry for character in "*?[]")
            and ".." not in PurePosixPath(entry).parts,
            f"unsupported Engine package files entry in {manifest_path}: {entry!r}",
        )
        allowed = package_root / entry
        require(allowed.exists(), f"Engine package files entry is missing: {allowed}")
        require(not allowed.is_symlink(), f"Engine package files entry is a symlink: {allowed}")
        if allowed.is_file():
            paths.add(allowed)
            continue
        for candidate in allowed.rglob("*"):
            require(not candidate.is_symlink(), f"Engine package source contains a symlink: {candidate}")
            if candidate.is_file():
                paths.add(candidate)
    return {
        path.relative_to(package_root).as_posix(): path.read_bytes()
        for path in sorted(paths)
    }


def directory_package_files(package_root: Path) -> dict[str, bytes]:
    require(package_root.is_dir(), f"installed npm package missing; run npm ci: {package_root}")
    require(not package_root.is_symlink(), f"installed npm package must not be a symlink: {package_root}")
    paths: list[Path] = []
    for candidate in package_root.rglob("*"):
        require(not candidate.is_symlink(), f"installed npm package contains a symlink: {candidate}")
        if candidate.is_file():
            paths.append(candidate)
    return {
        path.relative_to(package_root).as_posix(): path.read_bytes()
        for path in sorted(paths)
    }


def require_same_package_files(
    expected: dict[str, bytes],
    actual: dict[str, bytes],
    *,
    context: str,
) -> None:
    expected_names = set(expected)
    actual_names = set(actual)
    missing = sorted(expected_names - actual_names)
    unexpected = sorted(actual_names - expected_names)
    changed = sorted(name for name in expected_names & actual_names if expected[name] != actual[name])
    details = []
    if missing:
        details.append(f"missing={missing}")
    if unexpected:
        details.append(f"unexpected={unexpected}")
    if changed:
        details.append(f"changed={changed}")
    require(not details, f"{context}: " + "; ".join(details))


def python_source_package_files(package_root: Path) -> dict[str, bytes]:
    """Read the complete Python package source, excluding interpreter caches."""

    require(package_root.is_dir(), f"Python package source missing: {package_root}")
    require(not package_root.is_symlink(), f"Python package source must not be a symlink: {package_root}")
    files: dict[str, bytes] = {}
    for candidate in package_root.rglob("*"):
        relative = candidate.relative_to(package_root)
        if "__pycache__" in relative.parts or candidate.suffix in {".pyc", ".pyo"}:
            continue
        require(not candidate.is_symlink(), f"Python package source contains a symlink: {candidate}")
        if candidate.is_file():
            files[relative.as_posix()] = candidate.read_bytes()
    require(files, f"Python package source contains no files: {package_root}")
    return files


def python_wheel_package_files(wheel: Path, *, package_name: str) -> dict[str, bytes]:
    """Read one import package from a wheel while deliberately ignoring dist-info."""

    require(wheel.is_file(), f"Python wheel missing: {wheel}")
    files: dict[str, bytes] = {}
    try:
        with zipfile.ZipFile(wheel) as archive:
            for member in archive.infolist():
                member_path = PurePosixPath(member.filename)
                require(
                    not member_path.is_absolute() and ".." not in member_path.parts,
                    f"Python wheel contains unsafe entry: {wheel}: {member.filename}",
                )
                member_mode = member.external_attr >> 16
                require(
                    stat.S_IFMT(member_mode) != stat.S_IFLNK,
                    f"Python wheel contains a symlink: {wheel}: {member.filename}",
                )
                if member.is_dir():
                    continue
                require(member_path.parts, f"Python wheel contains an empty entry name: {wheel}")
                top_level = member_path.parts[0]
                if top_level.endswith(".dist-info"):
                    continue
                require(
                    len(member_path.parts) >= 2 and top_level == package_name,
                    f"Python wheel contains unexpected non-dist-info entry: {wheel}: {member.filename}",
                )
                relative = PurePosixPath(*member_path.parts[1:]).as_posix()
                require(relative not in files, f"Python wheel contains duplicate entry: {wheel}: {relative}")
                files[relative] = archive.read(member)
    except zipfile.BadZipFile as error:
        raise AssertionError(f"invalid Python wheel: {wheel}: {error}") from error
    require(files, f"Python wheel contains no {package_name} package files: {wheel}")
    return files


def verify_python_wheel_source(wheel: Path, source_root: Path) -> None:
    require_same_package_files(
        python_source_package_files(source_root),
        python_wheel_package_files(wheel, package_name=source_root.name),
        context=f"Python wheel differs from Engine source: {wheel.name}",
    )


def verify_npm_file_install(
    repository: Path,
    *,
    package_name: str,
    artifact_name: str,
    version: str,
) -> None:
    """Close vendor bytes, package-lock integrity and the installed package."""

    artifact = repository / "vendor" / artifact_name
    lock_path = repository / "package-lock.json"
    lock = read_json(lock_path)
    require(lock.get("lockfileVersion") == 3, f"npm lockfileVersion must be 3: {lock_path}")
    packages = lock.get("packages")
    require(isinstance(packages, dict), f"npm lock packages table missing: {lock_path}")
    lock_key = f"node_modules/{package_name}"
    entry = packages.get(lock_key)
    require(isinstance(entry, dict), f"npm lock entry missing: {lock_path}: {lock_key}")
    require(entry.get("version") == version, f"npm lock version mismatch: {lock_path}: {package_name}")
    expected_resolved = f"file:vendor/{artifact_name}"
    require(
        entry.get("resolved") == expected_resolved,
        f"npm lock resolved path mismatch: {lock_path}: {package_name}; expected {expected_resolved!r}",
    )
    expected_integrity = npm_sha512_integrity(artifact)
    require(
        entry.get("integrity") == expected_integrity,
        f"npm lock integrity differs from vendor bytes: {lock_path}: {package_name}; "
        f"expected {expected_integrity}",
    )
    archive_files = package_tarball_files(artifact)
    installed_files = directory_package_files(repository / lock_key)
    require_same_package_files(
        archive_files,
        installed_files,
        context=f"installed npm package differs from vendor artifact: {repository.name}: {package_name}",
    )


def verify_versions() -> None:
    require(scene_engine.__version__ == VERSIONS["python"], "Python import version mismatch")
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    require(
        re.search(r'^version = "0\.8\.0"$', pyproject, re.MULTILINE) is not None,
        "Python project version mismatch",
    )
    package(
        ROOT / "js/packages/client/package.json",
        name="@scene-engine/client",
        version=VERSIONS["client"],
    )
    package(
        ROOT / "js/packages/display/package.json",
        name="@scene-engine/display",
        version=VERSIONS["display"],
    )
    package(
        ROOT / "js/packages/renderer-three/package.json",
        name="@scene-engine/renderer-three",
        version=VERSIONS["renderer"],
    )
    require(WIRE_SCHEMA == "scene-engine-wire@2", "wire identity mismatch")
    require(DISPLAY_CODEC == "scene-engine-display-node@3", "Display codec mismatch")
    require(DISPLAY_CHECKPOINT_SCHEMA.endswith("@3"), "Display checkpoint mismatch")
    require(DISPLAY_COMMAND_STREAM_SCHEMA.endswith("@3"), "Display stream mismatch")
    require(DISPLAY_COMMAND_SCHEMA.endswith("@3"), "Display command mismatch")
    require(PACKET_LOG_SCHEMA == "scene-engine-packet-log@2", "packet-log mismatch")


def verify_source_shape() -> None:
    absent = (
        ROOT / "src/scene_engine/scene.py",
        ROOT / "js/packages/client/src/scene.js",
        ROOT / "js/packages/client/src/tree.js",
        ROOT / "js/packages/display/src/runtime/local-edit-port.js",
        ROOT / "js/packages/display/test/local-edit-port.test.mjs",
        ROOT / "fixtures/wire-v1",
        ROOT / "fixtures/scene-v1",
        WORKSPACE / "arts/authoring-tools",
    )
    for path in absent:
        require(not path.exists(), f"removed source still exists: {path.relative_to(WORKSPACE)}")
    required = (
        ROOT / "src/scene_engine/display.py",
        ROOT / "fixtures/wire-v2/checkpoint.bin",
        ROOT / "fixtures/display-v2/checkpoint.json",
        ROOT / "js/packages/display/src/index.js",
    )
    for path in required:
        require(path.exists(), f"required current source missing: {path.relative_to(ROOT)}")

    public = set(scene_engine.__all__)
    for name in ("DisplayCatalogIdentity", "DisplayCommand", "DisplayNode", "DisplayTransform"):
        require(name in public, f"Python public Display export missing: {name}")
    require("SceneNode" not in public, "removed Python scene export remains")


def verify_fixtures() -> None:
    for path in sorted((ROOT / "fixtures/wire-v2").glob("*.bin")):
        if path.name in {
            "nonfinite.bin",
            "trailing.bin",
            "truncated.bin",
            "unsafe-integer.bin",
            "wrong-magic.bin",
        }:
            continue
        packet = read_engine_packet(path.read_bytes())
        require(packet.header["schema"] == WIRE_SCHEMA, f"fixture schema mismatch: {path.name}")
    checkpoint = read_json(ROOT / "fixtures/display-v2/checkpoint.json")
    stream = read_json(ROOT / "fixtures/display-v2/command-tick.json")
    require(checkpoint["schema"] == DISPLAY_CHECKPOINT_SCHEMA, "Display checkpoint fixture mismatch")
    require(stream["schema"] == DISPLAY_COMMAND_STREAM_SCHEMA, "Display stream fixture mismatch")


def verify_artifacts() -> None:
    dist = ROOT / "dist"
    tarballs = sorted(path.name for path in dist.glob("*.tgz"))
    require(tarballs == sorted(ARTIFACTS), "Scene Engine dist artifact set is not exact")
    for package_name, (source_root, artifact_name, _version) in PACKAGE_ARTIFACTS.items():
        archive_files = package_tarball_files(dist / artifact_name)
        source_files = source_package_files(source_root)
        require_same_package_files(
            source_files,
            archive_files,
            context=f"npm artifact differs from Engine source: {package_name}",
        )
    arts_vendor = WORKSPACE / "arts/vendor"
    for name in ARTIFACTS:
        engine = dist / name
        arts = arts_vendor / name
        require(arts.exists(), f"Arts vendor artifact missing: {name}")
        require(engine.read_bytes() == arts.read_bytes(), f"Arts artifact differs: {name}")


def verify_python_game() -> None:
    root = WORKSPACE / "python-game"
    pyproject = (root / "pyproject.toml").read_text(encoding="utf-8")
    require(re.search(r'^version = "0\.8\.0"$', pyproject, re.MULTILINE), "game version mismatch")
    require('"scene-engine==0.8.0"' in pyproject, "game Engine dependency mismatch")
    wheels = sorted((root / "vendor").glob("scene_engine-*.whl"))
    require(len(wheels) == 1 and "0.8.0" in wheels[0].name, "game wheel set is not exact")
    wheel_files = python_wheel_package_files(wheels[0], package_name="scene_engine")
    require("scene.py" not in wheel_files, "wheel contains removed module")
    require("display.py" in wheel_files, "wheel lacks Display module")
    verify_python_wheel_source(wheels[0], ROOT / "src/scene_engine")
    lock = (root / "requirements.lock").read_text(encoding="utf-8")
    require(sha256(wheels[0]) in lock, "game wheel hash is not locked")


def verify_consumers() -> None:
    arts = WORKSPACE / "arts"
    arts_lock_path = arts / "package-lock.json"
    arts_lock_text = arts_lock_path.read_text(encoding="utf-8")
    arts_lock = json.loads(arts_lock_text)
    for name in REMOVED_ARTS_PACKAGES:
        require(not (arts / "packages" / name).exists(), f"removed Arts package exists: {name}")
        require(
            name not in arts_lock_text,
            f"removed Arts package remains in package-lock.json: {name}",
        )
    web3d = read_json(arts / "web3d/package.json")
    expected = {
        "@scene-engine/client": f"file:../vendor/{ARTIFACTS[0]}",
        "@scene-engine/display": f"file:../vendor/{ARTIFACTS[1]}",
        "@scene-engine/renderer-three": f"file:../vendor/{ARTIFACTS[2]}",
    }
    arts_lock_packages = arts_lock.get("packages")
    require(isinstance(arts_lock_packages, dict), f"npm lock packages table missing: {arts_lock_path}")
    arts_web3d_lock = arts_lock_packages.get("web3d")
    require(isinstance(arts_web3d_lock, dict), f"Arts Web3D lock entry missing: {arts_lock_path}")
    arts_web3d_dependencies = arts_web3d_lock.get("dependencies")
    require(
        isinstance(arts_web3d_dependencies, dict),
        f"Arts Web3D lock dependencies missing: {arts_lock_path}",
    )
    for name, value in expected.items():
        require(web3d["dependencies"].get(name) == value, f"Web3D dependency mismatch: {name}")
        require(
            arts_web3d_dependencies.get(name) == value,
            f"Arts package-lock Web3D dependency mismatch: {name}",
        )
        _source_root, artifact_name, version = PACKAGE_ARTIFACTS[name]
        verify_npm_file_install(
            arts,
            package_name=name,
            artifact_name=artifact_name,
            version=version,
        )


def verify_current_text() -> None:
    paths = [ROOT / "README.md", ROOT / "AGENTS.md", *sorted((ROOT / "docs").glob("*.md"))]
    for path in paths:
        source = path.read_text(encoding="utf-8")
        for token in STALE:
            require(token not in source, f"stale surface {token!r} in {path.relative_to(ROOT)}")
    display_source = (ROOT / "js/packages/display/src/index.js").read_text(encoding="utf-8")
    require("createDisplayRuntime" in display_source, "Display factory export missing")
    renderer_source = (ROOT / "js/packages/renderer-three/src/index.js").read_text(encoding="utf-8")
    require("createThreeRenderBackend" in renderer_source, "Three backend factory export missing")


def main() -> int:
    verify_versions()
    verify_source_shape()
    verify_fixtures()
    verify_artifacts()
    verify_python_game()
    verify_consumers()
    verify_current_text()
    print("Scene Engine Display repair and Showcase cutover verification passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
