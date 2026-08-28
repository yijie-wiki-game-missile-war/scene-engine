from __future__ import annotations

import io
import importlib.util
import json
import tarfile
import zipfile
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/verify_cutover.py"
SPEC = importlib.util.spec_from_file_location("verify_cutover", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
verify_cutover = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify_cutover)

npm_sha512_integrity = verify_cutover.npm_sha512_integrity
package_tarball_files = verify_cutover.package_tarball_files
require_same_package_files = verify_cutover.require_same_package_files
source_package_files = verify_cutover.source_package_files
verify_npm_file_install = verify_cutover.verify_npm_file_install
verify_python_wheel_source = verify_cutover.verify_python_wheel_source


def _write_tarball(path: Path, files: dict[str, bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(path, mode="w:gz") as archive:
        for relative, contents in files.items():
            info = tarfile.TarInfo(f"package/{relative}")
            info.size = len(contents)
            archive.addfile(info, io.BytesIO(contents))


def _write_source_package(root: Path) -> dict[str, bytes]:
    files = {
        "package.json": json.dumps(
            {
                "name": "@scene-engine/example",
                "version": "1.2.3",
                "files": ["src"],
            },
            separators=(",", ":"),
        ).encode(),
        "src/index.js": b"export const value = 1;\n",
    }
    for relative, contents in files.items():
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(contents)
    return files


def _write_wheel(path: Path, files: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        for relative, contents in files.items():
            archive.writestr(f"scene_engine/{relative}", contents)
        archive.writestr("scene_engine-0.9.0.dist-info/METADATA", b"ignored metadata\n")


def test_package_tarball_is_closed_against_engine_source(tmp_path: Path) -> None:
    source_root = tmp_path / "source"
    expected = _write_source_package(source_root)
    artifact = tmp_path / "example.tgz"
    _write_tarball(artifact, expected)

    require_same_package_files(
        source_package_files(source_root),
        package_tarball_files(artifact),
        context="test package",
    )

    (source_root / "src/index.js").write_text("export const value = 2;\n", encoding="utf-8")
    with pytest.raises(AssertionError, match=r"test package: changed=\['src/index.js'\]"):
        require_same_package_files(
            source_package_files(source_root),
            package_tarball_files(artifact),
            context="test package",
        )


def test_npm_file_install_closes_lock_vendor_and_installed_bytes(tmp_path: Path) -> None:
    package_name = "@scene-engine/example"
    artifact_name = "scene-engine-example-1.2.3.tgz"
    files = _write_source_package(tmp_path / "unused-source")
    artifact = tmp_path / "vendor" / artifact_name
    _write_tarball(artifact, files)
    lock_key = f"node_modules/{package_name}"
    (tmp_path / "package-lock.json").write_text(
        json.dumps(
            {
                "lockfileVersion": 3,
                "packages": {
                    lock_key: {
                        "version": "1.2.3",
                        "resolved": f"file:vendor/{artifact_name}",
                        "integrity": npm_sha512_integrity(artifact),
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    installed = tmp_path / lock_key
    for relative, contents in files.items():
        destination = installed / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(contents)

    verify_npm_file_install(
        tmp_path,
        package_name=package_name,
        artifact_name=artifact_name,
        version="1.2.3",
    )

    (installed / "src/index.js").write_text("stale cached contents\n", encoding="utf-8")
    with pytest.raises(AssertionError, match="installed npm package differs from vendor artifact"):
        verify_npm_file_install(
            tmp_path,
            package_name=package_name,
            artifact_name=artifact_name,
            version="1.2.3",
        )


def test_npm_file_install_rejects_integrity_for_different_vendor_bytes(tmp_path: Path) -> None:
    package_name = "@scene-engine/example"
    artifact_name = "scene-engine-example-1.2.3.tgz"
    files = _write_source_package(tmp_path / "unused-source")
    artifact = tmp_path / "vendor" / artifact_name
    _write_tarball(artifact, files)
    lock_key = f"node_modules/{package_name}"
    (tmp_path / "package-lock.json").write_text(
        json.dumps(
            {
                "lockfileVersion": 3,
                "packages": {
                    lock_key: {
                        "version": "1.2.3",
                        "resolved": f"file:vendor/{artifact_name}",
                        "integrity": "sha512-stale-cache-entry",
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(AssertionError, match="npm lock integrity differs from vendor bytes"):
        verify_npm_file_install(
            tmp_path,
            package_name=package_name,
            artifact_name=artifact_name,
            version="1.2.3",
        )


def test_python_wheel_rejects_stale_package_files_but_ignores_dist_info(tmp_path: Path) -> None:
    source_root = tmp_path / "scene_engine"
    source_root.mkdir()
    (source_root / "__init__.py").write_bytes(b'__version__ = "0.9.0"\n')
    (source_root / "display.py").write_bytes(b"DISPLAY_CODEC = 'scene-engine-display-node@3'\n")
    cache = source_root / "__pycache__"
    cache.mkdir()
    (cache / "scene.cpython-312.pyc").write_bytes(b"ignored interpreter cache")
    wheel = tmp_path / "scene_engine-0.9.0-py3-none-any.whl"
    _write_wheel(
        wheel,
        {
            "__init__.py": (source_root / "__init__.py").read_bytes(),
            "display.py": (source_root / "display.py").read_bytes(),
            "scene.py": b"stale removed module\n",
        },
    )

    with pytest.raises(AssertionError, match=r"unexpected=\['scene.py'\]"):
        verify_python_wheel_source(wheel, source_root)
