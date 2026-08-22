from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys


FIXTURE = Path(__file__).parent / "fixtures" / "presentation-archive-v3"


def test_python_archive_fixture_is_byte_reproducible_and_self_describing() -> None:
    subprocess.run(
        [
            sys.executable,
            str(Path(__file__).parent / "tools" / "generate_presentation_archive_fixture.py"),
            "--check",
        ],
        check=True,
    )
    metadata = json.loads((FIXTURE / "fixture-metadata.json").read_text())
    tape = metadata["tape"].encode()
    assert hashlib.sha256(tape).hexdigest() == metadata["source_authority_sha256"]
    assert metadata["archive_manifest"]["source_authority_sha256"] == metadata[
        "source_authority_sha256"
    ]
    assert metadata["archive_manifest"]["entry_count"] == "9"
    assert metadata["archive_manifest"]["frame_count"] == "3"
    assert metadata["archive_manifest"]["correlation_count"] == "4"
    assert [item["frame_seqs"] for item in metadata["archive_layout"]] == [
        [1],
        [],
        [2],
        [1],
    ]
    assert [item["source_tick"] for item in metadata["archive_layout"]] == [
        0,
        0,
        1,
        1,
    ]


def test_archive_semantic_failure_variants_are_machine_readable() -> None:
    expected = {
        "unknown-visual",
        "unknown-animation",
        "dangling-parent",
        "id-reuse",
        "bootstrap-frame-byte-limit",
        "replay-frame-byte-limit",
        "bootstrap-node-limit",
    }
    actual = {path.name for path in (FIXTURE / "variants").iterdir() if path.is_dir()}
    assert actual == expected
    source_hashes = set()
    for name in expected:
        metadata = json.loads(
            (FIXTURE / "variants" / name / "fixture-metadata.json").read_text()
        )
        assert metadata["expected_semantic_error"] == name
        source_hashes.add(metadata["source_authority_sha256"])
    assert len(source_hashes) == 1
