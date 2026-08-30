#!/usr/bin/env python3
"""Build deterministic bundle and source-with-docs zip artifacts."""

from __future__ import annotations

import os
import tempfile
import zipfile
from pathlib import Path

from verify_cutover import (
    ARTIFACTS,
    BUNDLE_ARCHIVE,
    PYTHON_WHEEL,
    ROOT,
    SOURCE_ARCHIVE,
    release_source_archive_files,
)


def _write_zip(path: Path, files: dict[str, bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(
            temporary,
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
        ) as archive:
            for name, contents in sorted(files.items()):
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, contents, compresslevel=9)
        temporary.chmod(0o644)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    dist = ROOT / "dist"
    bundle_inputs = (*ARTIFACTS, PYTHON_WHEEL)
    missing = [name for name in bundle_inputs if not (dist / name).is_file()]
    if missing:
        raise SystemExit(f"canonical release inputs missing from {dist}: {missing}")
    _write_zip(
        dist / BUNDLE_ARCHIVE,
        {name: (dist / name).read_bytes() for name in bundle_inputs},
    )
    _write_zip(dist / SOURCE_ARCHIVE, release_source_archive_files())
    print(dist / BUNDLE_ARCHIVE)
    print(dist / SOURCE_ARCHIVE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
