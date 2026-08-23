#!/usr/bin/env python3
"""Regenerate the frozen cross-language Scene Engine 0.6 fixtures."""

from __future__ import annotations

import argparse
import json
import shutil
import struct
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from scene_engine.recording import PacketLogWriter  # noqa: E402
from scene_engine.scene import (  # noqa: E402
    SceneEvent,
    SceneNode,
    VisualType,
    encode_scene_bootstrap,
    encode_scene_frame,
)
from scene_engine.wire import (  # noqa: E402
    AttachmentEncoding,
    AttachmentKind,
    PacketKind,
    WIRE_MAGIC,
    WIRE_MAJOR_VERSION,
    encode_ack,
    encode_checkpoint,
    encode_commit,
    encode_engine_packet,
    encode_input,
    encode_input_result,
)


STREAM = "00000000-0000-4000-8000-000000000001"
WORLD_CODEC = "example-world@1"


def canonical(value) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        + b"\n"
    )


def reset(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--python-only",
        action="store_true",
        help="leave the packaged JavaScript packet-log fixture untouched",
    )
    args = parser.parse_args()
    wire_root = ROOT / "fixtures" / "wire-v1"
    scene_root = ROOT / "fixtures" / "scene-v1"
    tree_root = ROOT / "fixtures" / "json-tree-v1"
    package_log = ROOT / "js" / "packages" / "client" / "fixtures" / "packet-log"
    targets = [wire_root, scene_root, tree_root]
    if not args.python_only:
        targets.append(package_log)
    for target in targets:
        reset(target)

    bootstrap = encode_scene_bootstrap(
        maximum_dynamic_nodes=128,
        maximum_frame_bytes=1024 * 1024,
        visual_types=(VisualType(1),),
    )
    frame0 = encode_scene_frame(source_tick=0, nodes=(node(0.0),))
    frame1 = encode_scene_frame(
        source_tick=1,
        nodes=(node(1.5),),
        events=(SceneEvent(1, 1, 0, 1, 0, 1, b"tick"),),
    )
    snapshot = {
        "meta": {
            "float": 1.5,
            "large": 1e20,
            "negative_zero": -0.0,
            "one": 1.0,
            "small": 1e-7,
        },
        "state": {"items": [], "stable": {"value": 7}},
        "tick": 0,
        "world_revision": 0,
    }
    tick_patch = {
        "schema": "scene-engine-json-tree@1",
        "changes": [
            {"op": "set", "path": ["meta", "float"], "value": 2.5},
            {"op": "append", "path": ["state", "items"], "values": [{"id": "one"}]},
            {"op": "set", "path": ["tick"], "value": 1},
            {"op": "set", "path": ["world_revision"], "value": 1},
        ],
    }
    input_patch = {
        "schema": "scene-engine-json-tree@1",
        "changes": [
            {"op": "set", "path": ["state", "stable", "value"], "value": 8},
            {"op": "set", "path": ["world_revision"], "value": 2},
        ],
    }
    checkpoint = encode_checkpoint(
        stream_id=STREAM,
        commit_seq=0,
        source_tick=0,
        world_revision=0,
        world_codec=WORLD_CODEC,
        world_snapshot=snapshot,
        scene_bootstrap=bootstrap,
        scene_frame=frame0,
    )
    commit_tick = encode_commit(
        stream_id=STREAM,
        commit_seq=1,
        source_tick=1,
        world_revision=1,
        cause="tick",
        causation_id=None,
        world_codec=WORLD_CODEC,
        world_patch=tick_patch,
        scene_frame=frame1,
    )
    commit_input = encode_commit(
        stream_id=STREAM,
        commit_seq=2,
        source_tick=1,
        world_revision=2,
        cause="input",
        causation_id="client-a:1",
        world_codec=WORLD_CODEC,
        world_patch=input_patch,
        scene_frame=None,
    )
    final_snapshot = {
        "meta": {
            "float": 2.5,
            "large": 1e20,
            "negative_zero": -0.0,
            "one": 1.0,
            "small": 1e-7,
        },
        "state": {"items": [{"id": "one"}], "stable": {"value": 8}},
        "tick": 1,
        "world_revision": 2,
    }
    periodic_checkpoint = encode_checkpoint(
        stream_id=STREAM,
        commit_seq=2,
        source_tick=1,
        world_revision=2,
        world_codec=WORLD_CODEC,
        world_snapshot=final_snapshot,
        scene_bootstrap=bootstrap,
        scene_frame=frame1,
    )
    input_packet = encode_input(
        input_id="client-a:2",
        observed_stream_id=STREAM,
        observed_commit_seq=2,
        command="example.set",
        args={"large": 1e20, "negative_zero": -0.0, "small": 1e-7, "value": 1.5},
    )
    ack = encode_ack(stream_id=STREAM, commit_seq=2)
    input_result = encode_input_result(
        input_id="client-a:2",
        status="no-op",
        reason_code="unchanged",
        result={"value": 1.0},
    )
    packets = {
        "checkpoint.bin": checkpoint,
        "commit-tick.bin": commit_tick,
        "commit-input.bin": commit_input,
        "input.bin": input_packet,
        "ack.bin": ack,
        "input-result.bin": input_result,
    }
    for name, data in packets.items():
        (wire_root / name).write_bytes(data)
    (scene_root / "bootstrap.bin").write_bytes(bootstrap)
    (scene_root / "frame-0.bin").write_bytes(frame0)
    (scene_root / "frame-1.bin").write_bytes(frame1)
    (tree_root / "snapshot.json").write_bytes(canonical(snapshot))
    (tree_root / "commit-tick.json").write_bytes(canonical(tick_patch))
    (tree_root / "commit-input.json").write_bytes(canonical(input_patch))

    malformed = {
        "wrong-magic.bin": b"NOPE" + checkpoint[4:],
        "truncated.bin": checkpoint[:-1],
        "trailing.bin": checkpoint + b"\x00",
        "unsafe-integer.bin": raw_input_json(b'{"value":9007199254740992}'),
        "nonfinite.bin": raw_input_json(b'{"value":NaN}'),
    }
    for name, data in malformed.items():
        (wire_root / name).write_bytes(data)
    (wire_root / "malformed-manifest.json").write_bytes(
        canonical({"schema": "scene-engine-malformed-corpus@1", "files": sorted(malformed)})
    )

    if not args.python_only:
        writer = PacketLogWriter(package_log, fsync=False)
        writer.append(checkpoint, checkpoint=True)
        writer.append(commit_tick, checkpoint=False)
        writer.append(commit_input, checkpoint=False)
        writer.append(periodic_checkpoint, checkpoint=True)
        writer.seal()
        malformed_log = package_log / "malformed"
        malformed_log.mkdir()
        for name in ("manifest.json", "index.json"):
            shutil.copyfile(package_log / name, malformed_log / name)
        (malformed_log / "packets.bin").write_bytes(
            (package_log / "packets.bin").read_bytes()[:-1]
        )


def node(x: float) -> SceneNode:
    return SceneNode(
        display_id=1,
        parent_display_id=0,
        visual_type_id=1,
        flags=1,
        local_position=(x, 0.0, 0.0),
        local_rotation_xyzw=(0.0, 0.0, 0.0, 1.0),
        local_scale=(1.0, 1.0, 1.0),
    )


def raw_input_json(payload: bytes) -> bytes:
    header = canonical(
        {
            "schema": "scene-engine-wire@1",
            "type": "engine.input",
            "input_id": "malformed:1",
            "observed_stream_id": STREAM,
            "observed_commit_seq": 0,
            "command": "example",
        }
    ).rstrip(b"\n")
    fixed = struct.pack(
        "<4sBBHIHH", WIRE_MAGIC, WIRE_MAJOR_VERSION, int(PacketKind.INPUT), 0,
        len(header), 1, 0,
    )
    attachment = struct.pack(
        "<BBHI", int(AttachmentKind.INPUT_PAYLOAD), int(AttachmentEncoding.JSON),
        0, len(payload),
    )
    return fixed + header + attachment + payload


if __name__ == "__main__":
    main()
