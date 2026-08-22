#!/usr/bin/env python3
"""Regenerate deterministic Python-writer -> Node-reader Archive V3 fixtures."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from typing import Any, Iterable


REPOSITORY = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY / "src"))

from scene_engine.authority_cursor import AuthorityCursorEnvelope  # noqa: E402
from scene_engine.packet_codec import (  # noqa: E402
    encode_presentation_frame_v3_packet,
    encode_scene_bootstrap_v3_packet,
)
from scene_engine.presentation_archive import (  # noqa: E402
    PRESENTATION_ARCHIVE_INDEX,
    PRESENTATION_ARCHIVE_MANIFEST,
    PRESENTATION_ARCHIVE_SEGMENTS,
    PresentationArchiveWriter,
)
from scene_engine.presentation_control_v2 import (  # noqa: E402
    PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    cursor_envelope_to_json,
    encode_presentation_control_v2,
)
from scene_engine.presentation_frame import (  # noqa: E402
    OpaquePayloadV3,
    PresentationNodeV3,
    encode_presentation_frame_v3,
)
from scene_engine.scene_bootstrap import (  # noqa: E402
    AnimationStateRecordV3,
    EngineSessionIdentityV3,
    VisualTypeRecordV3,
    encode_scene_bootstrap_v3,
)


FIXTURE_ROOT = REPOSITORY / "tests" / "fixtures" / "presentation-archive-v3"
SOURCE_TAPE = Path(__file__).with_name("presentation_archive_source_tape.json")
SOURCE_TAPE_SHA256 = "eeae08665bb6f51a88f411d863378b9d48db1174acf683dd6111fea2971ccc6f"
ARCHIVE_FILES = (
    PRESENTATION_ARCHIVE_MANIFEST,
    PRESENTATION_ARCHIVE_INDEX,
    PRESENTATION_ARCHIVE_SEGMENTS,
)
GENERATED_FILES = (*ARCHIVE_FILES, "fixture-metadata.json")
VARIANTS = (
    "unknown-visual",
    "unknown-animation",
    "dangling-parent",
    "id-reuse",
    "bootstrap-frame-byte-limit",
    "replay-frame-byte-limit",
    "bootstrap-node-limit",
)

PROFILE_IDENTITY = "mw-presentation-v3@1"
CURSOR_CODEC_IDENTITY = "mw-v5-authority-cursor@1"
VIEWER_SCOPE = "viewer:test"
SOURCE_ARTIFACT_IDENTITY = "mw-v5-tape:scene-engine-cross-language-fixture"


def _json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    ).encode("utf-8")


def _authority_fixture() -> tuple[list[dict[str, str]], str, list[dict[str, Any]]]:
    raw = SOURCE_TAPE.read_bytes()
    if raw.endswith(b"\n"):
        raw = raw[:-1]
    tape = raw.decode("utf-8", errors="strict")
    if hashlib.sha256(raw).hexdigest() != SOURCE_TAPE_SHA256:
        raise RuntimeError("cross-language source tape bytes changed")
    records = json.loads(tape)
    authority_frames = [
        json.loads(record["raw"])
        for record in records
        if record["channel"] == "authority"
    ]
    if len(authority_frames) != 4:
        raise RuntimeError("cross-language source tape authority layout changed")
    return records, tape, authority_frames


def _cursor(frame: dict[str, Any]) -> AuthorityCursorEnvelope:
    return AuthorityCursorEnvelope(
        CURSOR_CODEC_IDENTITY,
        _json_bytes(
            {
                "snapshot_id": frame["snapshot_id"],
                "state_epoch": frame["state_epoch"],
                "state_seq": frame["state_seq"],
                "state_stream_id": frame["state_stream_id"],
                "tick": frame["tick"],
                "world_revision": frame["world_revision"],
            }
        ),
    )


def _node(
    *,
    display_id: int = 1,
    parent_display_id: int = 0,
    visual_type_id: int = 1,
    animation_state_id: int = 1,
    source_tick: int,
) -> PresentationNodeV3:
    return PresentationNodeV3(
        display_id=display_id,
        parent_display_id=parent_display_id,
        visual_type_id=visual_type_id,
        flags=1,
        local_position=(float(source_tick), 0.0, 0.0),
        local_rotation_xyzw=(0.0, 0.0, 0.0, 1.0),
        local_scale=(1.0, 1.0, 1.0),
        animation_state_id=animation_state_id,
        animation_start_tick=source_tick,
        animation_flags=1,
        profile=OpaquePayloadV3(1, b"fixture-node"),
    )


def _frames_for_variant(
    variant: str | None, authority_frames: list[dict[str, Any]]
) -> list[list[tuple[PresentationNodeV3, ...]]]:
    ticks = [int(frame["tick"]) for frame in authority_frames]
    normal = [
        [(_node(source_tick=ticks[0]),)],
        [],
        [(_node(source_tick=ticks[2]),)],
        [(_node(source_tick=ticks[3]),)],
    ]
    if variant == "unknown-visual":
        normal[0] = [(_node(source_tick=ticks[0], visual_type_id=999),)]
    elif variant == "unknown-animation":
        normal[0] = [(_node(source_tick=ticks[0], animation_state_id=999),)]
    elif variant == "dangling-parent":
        normal[0] = [
            (_node(display_id=2, parent_display_id=1, source_tick=ticks[0]),)
        ]
    elif variant == "id-reuse":
        normal[1] = [tuple()]
        normal[2] = [(_node(source_tick=ticks[2]),)]
    elif variant == "bootstrap-node-limit":
        normal[0] = [
            (
                _node(source_tick=ticks[0]),
                _node(display_id=2, source_tick=ticks[0]),
            )
        ]
    return normal


def _bootstrap_packet(
    authority: dict[str, Any], *, scene_epoch: int, bootstrap_id: int,
    maximum_dynamic_nodes: int, maximum_frame_bytes: int,
) -> bytes:
    return encode_scene_bootstrap_v3_packet(
        encode_scene_bootstrap_v3(
            scene_epoch=scene_epoch,
            bootstrap_id=bootstrap_id,
            identity=EngineSessionIdentityV3(
                "scene-engine-cross-language-fixture",
                VIEWER_SCOPE,
                PROFILE_IDENTITY,
            ),
            authority_baseline=_cursor(authority),
            maximum_dynamic_nodes=maximum_dynamic_nodes,
            maximum_frame_bytes=maximum_frame_bytes,
            visual_types=(VisualTypeRecordV3(1, 0, 1, 0),),
            animation_states=(AnimationStateRecordV3(1, 1, 60),),
        )
    )


def _correlation(
    *, authority: dict[str, Any], scene_epoch: int, bootstrap_id: int,
    correlation_seq: int, projection_id: int,
    frame_refs: list[dict[str, str]],
) -> bytes:
    return encode_presentation_control_v2(
        {
            "bootstrap_id": str(bootstrap_id),
            "message_id": f"fixture-correlation:{scene_epoch}:{correlation_seq}",
            "payload": {
                "authority_cursor": cursor_envelope_to_json(_cursor(authority)),
                "correlation_seq": str(correlation_seq),
                "frame_refs": frame_refs,
                "presentation_required": bool(frame_refs),
                "projection_id": str(projection_id),
                "source_tick": str(authority["tick"]),
            },
            "protocol": "scene-presentation-control-v2",
            "scene_epoch": str(scene_epoch),
            "schema_version": 1,
            "session_seq": correlation_seq,
            "type": "presentation.correlation",
            "viewer_scope": VIEWER_SCOPE,
        },
        direction=PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    )


def _build_archive(
    directory: Path,
    *,
    variant: str | None,
    records: list[dict[str, str]],
    tape: str,
    authority_frames: list[dict[str, Any]],
) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for name in GENERATED_FILES:
        (directory / name).unlink(missing_ok=True)

    source_sha256 = hashlib.sha256(tape.encode()).hexdigest()
    writer = PresentationArchiveWriter(
        directory,
        profile_identity=PROFILE_IDENTITY,
        source_authority_artifact_identity=SOURCE_ARTIFACT_IDENTITY,
        source_authority_sha256=source_sha256,
        authority_cursor_codec_identity=CURSOR_CODEC_IDENTITY,
        exporter_identity="scene-engine-cross-language-fixture-exporter@1",
        scene_engine_identity="scene-engine@0.4.0",
        visual_manifest_identity="fixture-visuals@1",
        resource_manifest_identity="fixture-resources@1",
    )
    frames_by_authority = _frames_for_variant(variant, authority_frames)
    layout: list[dict[str, Any]] = []
    groups = (
        (0, 3, 1, 9, 11),
        (3, 4, 2, 10, 12),
    )
    for begin, end, checkpoint_id, scene_epoch, bootstrap_id in groups:
        bootstrap_maximum_nodes = (
            1 if variant == "bootstrap-node-limit" and checkpoint_id == 1 else 100
        )
        bootstrap_maximum_bytes = 1_048_576
        if variant == "bootstrap-frame-byte-limit" and checkpoint_id == 1:
            bootstrap_maximum_bytes = 64
        elif variant == "replay-frame-byte-limit" and checkpoint_id == 1:
            bootstrap_maximum_bytes = 8 * 1024 * 1024 + 1
        baseline = authority_frames[begin]
        writer.start_segment(
            checkpoint_id=checkpoint_id,
            scene_epoch=scene_epoch,
            bootstrap_id=bootstrap_id,
            source_tick=int(baseline["tick"]),
            bootstrap_packet=_bootstrap_packet(
                baseline,
                scene_epoch=scene_epoch,
                bootstrap_id=bootstrap_id,
                maximum_dynamic_nodes=bootstrap_maximum_nodes,
                maximum_frame_bytes=bootstrap_maximum_bytes,
            ),
        )
        frame_seq = 0
        for correlation_seq, authority_index in enumerate(range(begin, end), 1):
            authority = authority_frames[authority_index]
            projection_id = authority_index + 1
            frame_refs: list[dict[str, str]] = []
            for nodes in frames_by_authority[authority_index]:
                frame_seq += 1
                packet = encode_presentation_frame_v3_packet(
                    encode_presentation_frame_v3(
                        scene_epoch=scene_epoch,
                        bootstrap_id=bootstrap_id,
                        frame_seq=frame_seq,
                        source_tick=int(authority["tick"]),
                        projection_id=projection_id,
                        nodes=nodes,
                    )
                )
                writer.append_frame(
                    frame_seq=frame_seq,
                    source_tick=int(authority["tick"]),
                    projection_id=projection_id,
                    packet=packet,
                )
                frame_refs.append(
                    {
                        "frame_seq": str(frame_seq),
                        "sha256": hashlib.sha256(packet).hexdigest(),
                    }
                )
            writer.append_correlation(
                _correlation(
                    authority=authority,
                    scene_epoch=scene_epoch,
                    bootstrap_id=bootstrap_id,
                    correlation_seq=correlation_seq,
                    projection_id=projection_id,
                    frame_refs=frame_refs,
                )
            )
            layout.append(
                {
                    "authority_index": authority_index,
                    "bootstrap_id": bootstrap_id,
                    "correlation_seq": correlation_seq,
                    "frame_seqs": [int(item["frame_seq"]) for item in frame_refs],
                    "projection_id": projection_id,
                    "scene_epoch": scene_epoch,
                    "source_tick": int(authority["tick"]),
                    "state_seq": int(authority["state_seq"]),
                    "type": authority["type"],
                }
            )
    manifest = writer.seal()
    metadata = {
        "archive_layout": layout,
        "archive_manifest": manifest,
        "expected_semantic_error": variant,
        "files": {
            name: {
                "bytes": (directory / name).stat().st_size,
                "sha256": hashlib.sha256((directory / name).read_bytes()).hexdigest(),
            }
            for name in ARCHIVE_FILES
        },
        "fixture_schema_identity": "scene-presentation-archive-v3-fixture@1",
        "records": records,
        "source_authority_artifact_identity": SOURCE_ARTIFACT_IDENTITY,
        "source_authority_sha256": source_sha256,
        "tape": tape,
        "variant": variant or "valid",
    }
    (directory / "fixture-metadata.json").write_bytes(_json_bytes(metadata) + b"\n")


def _generated_paths() -> Iterable[Path]:
    for name in GENERATED_FILES:
        yield Path(name)
    for variant in VARIANTS:
        for name in GENERATED_FILES:
            yield Path("variants") / variant / name


def _generate(root: Path) -> None:
    records, tape, authority_frames = _authority_fixture()
    _build_archive(
        root,
        variant=None,
        records=records,
        tape=tape,
        authority_frames=authority_frames,
    )
    for variant in VARIANTS:
        _build_archive(
            root / "variants" / variant,
            variant=variant,
            records=records,
            tape=tape,
            authority_frames=authority_frames,
        )


def _check() -> None:
    with tempfile.TemporaryDirectory(prefix="scene-engine-archive-fixture-") as raw:
        generated = Path(raw)
        _generate(generated)
        differences = [
            str(path)
            for path in _generated_paths()
            if not (FIXTURE_ROOT / path).is_file()
            or (FIXTURE_ROOT / path).read_bytes() != (generated / path).read_bytes()
        ]
    if differences:
        raise SystemExit(
            "presentation archive fixture is stale: {}".format(", ".join(differences))
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="regenerate in a temporary directory and compare exact bytes",
    )
    args = parser.parse_args()
    if args.check:
        _check()
    else:
        FIXTURE_ROOT.mkdir(parents=True, exist_ok=True)
        _generate(FIXTURE_ROOT)


if __name__ == "__main__":
    main()
