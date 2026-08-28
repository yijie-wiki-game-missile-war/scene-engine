#!/usr/bin/env python3
"""Regenerate the frozen cross-language Scene Engine wire/display @2 fixtures."""

from __future__ import annotations

import argparse
import json
import shutil
import struct
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from scene_engine.display import (  # noqa: E402
    DisplayCatalogIdentity,
    DisplayCommand,
    DisplayNode,
    DisplayTransform,
    encode_display_checkpoint,
    encode_display_command_stream,
)
from scene_engine.recording import PacketLogWriter  # noqa: E402
from scene_engine.wire import (  # noqa: E402
    AttachmentEncoding,
    AttachmentKind,
    PacketKind,
    WIRE_MAGIC,
    WIRE_MAJOR_VERSION,
    WIRE_SCHEMA,
    encode_ack,
    encode_checkpoint,
    encode_commit,
    encode_input,
    encode_input_result,
)


STREAM = "00000000-0000-4000-8000-000000000001"
WORLD_CODEC = "example-world@1"
CATALOG = DisplayCatalogIdentity("a" * 64, "b" * 64, "c" * 64)


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


def transform(x: float) -> DisplayTransform:
    return DisplayTransform(
        position=(x, 0.0, 0.0),
        rotation_xyzw=(0.0, 0.0, 0.0, 1.0),
        scale=(1.0, 1.0, 1.0),
    )


def node(
    name: str,
    *,
    x: float = 0.0,
    parent_name: str | None = None,
    prefab_id: str = "flight.aircraft",
    visible: bool = True,
    state: dict | None = None,
) -> DisplayNode:
    return DisplayNode(
        name=name,
        parent_name=parent_name,
        prefab_id=prefab_id,
        transform_mode="live",
        transform=transform(x),
        visible=visible,
        state=state or {"animation": "idle"},
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--python-only",
        action="store_true",
        help="leave the packaged JavaScript packet-log fixture untouched",
    )
    args = parser.parse_args()
    wire_root = ROOT / "fixtures" / "wire-v2"
    display_root = ROOT / "fixtures" / "display-v2"
    tree_root = ROOT / "fixtures" / "json-tree-v1"
    package_wire_root = ROOT / "js" / "packages" / "client" / "fixtures" / "wire-v2"
    package_log = ROOT / "js" / "packages" / "client" / "fixtures" / "packet-log"
    targets = [wire_root, display_root, tree_root]
    if not args.python_only:
        targets.append(package_wire_root)
        targets.append(package_log)
    for target in targets:
        reset(target)

    initial_nodes = (
        node("py/root", prefab_id="world.anchor"),
        node("py/aircraft", parent_name="py/root"),
    )
    display_checkpoint = encode_display_checkpoint(
        scene_name="main",
        catalog=CATALOG,
        last_command_seq=0,
        nodes=initial_nodes,
    )
    commands = (
        DisplayCommand.create_node(
            node("py/transient", parent_name="py/root", prefab_id="effects.marker")
        ),
        DisplayCommand.set_transform("py/aircraft", transform(1.5)),
        DisplayCommand.set_parent("py/aircraft", "py/root"),
        DisplayCommand.set_visible("py/aircraft", False),
        DisplayCommand.set_state("py/aircraft", {"animation": "moving"}),
        DisplayCommand.replace_prefab(
            "py/aircraft", "flight.aircraft-damaged", {"animation": "damaged"}
        ),
        DisplayCommand.remove("py/transient"),
    )
    display_tick, command_cursor = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        commands=commands,
    )
    display_input, final_cursor = encode_display_command_stream(
        base_command_seq=command_cursor,
        source_tick=1,
        commands=(),
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
        last_command_seq=0,
        world_codec=WORLD_CODEC,
        world_snapshot=snapshot,
        display_checkpoint=display_checkpoint,
    )
    commit_tick = encode_commit(
        stream_id=STREAM,
        commit_seq=1,
        source_tick=1,
        world_revision=1,
        last_command_seq=command_cursor,
        cause="tick",
        causation_id=None,
        world_codec=WORLD_CODEC,
        world_patch=tick_patch,
        display_commands=display_tick,
    )
    commit_input = encode_commit(
        stream_id=STREAM,
        commit_seq=2,
        source_tick=1,
        world_revision=2,
        last_command_seq=final_cursor,
        cause="input",
        causation_id="client-a:1",
        world_codec=WORLD_CODEC,
        world_patch=input_patch,
        display_commands=display_input,
    )
    final_nodes = (
        node("py/root", prefab_id="world.anchor"),
        node(
            "py/aircraft",
            x=1.5,
            parent_name="py/root",
            prefab_id="flight.aircraft-damaged",
            visible=False,
            state={"animation": "damaged"},
        ),
    )
    final_display_checkpoint = encode_display_checkpoint(
        scene_name="main",
        catalog=CATALOG,
        last_command_seq=final_cursor,
        nodes=final_nodes,
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
        last_command_seq=final_cursor,
        world_codec=WORLD_CODEC,
        world_snapshot=final_snapshot,
        display_checkpoint=final_display_checkpoint,
    )
    packets = {
        "checkpoint.bin": checkpoint,
        "commit-tick.bin": commit_tick,
        "commit-input.bin": commit_input,
        "input.bin": encode_input(
            input_id="client-a:2",
            observed_stream_id=STREAM,
            observed_commit_seq=2,
            command="example.set",
            args={"large": 1e20, "negative_zero": -0.0, "value": 1.5},
        ),
        "ack.bin": encode_ack(
            stream_id=STREAM,
            commit_seq=2,
            last_command_seq=final_cursor,
        ),
        "input-result.bin": encode_input_result(
            input_id="client-a:2",
            status="no-op",
            reason_code="unchanged",
            result={"value": 1.0},
        ),
    }
    for name, data in packets.items():
        (wire_root / name).write_bytes(data)
        if not args.python_only:
            (package_wire_root / name).write_bytes(data)
    for name, data in {
        "checkpoint.json": display_checkpoint,
        "command-tick.json": display_tick,
        "command-input-empty.json": display_input,
        "periodic-checkpoint.json": final_display_checkpoint,
    }.items():
        (display_root / name).write_bytes(canonical(data))
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
        canonical({"schema": "scene-engine-malformed-corpus@2", "files": sorted(malformed)})
    )
    malformed_display = {
        "command-sequence-gap.json": {
            **display_tick,
            "commands": [
                {**display_tick["commands"][0], "command_seq": 2},
                *display_tick["commands"][1:],
            ],
        },
        "command-source-tick.json": {
            **display_tick,
            "commands": [
                {**display_tick["commands"][0], "source_tick": 2},
                *display_tick["commands"][1:],
            ],
        },
    }
    for name, data in malformed_display.items():
        (display_root / name).write_bytes(canonical(data))

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


def raw_input_json(payload: bytes) -> bytes:
    header = canonical(
        {
            "schema": WIRE_SCHEMA,
            "type": "engine.input",
            "input_id": "malformed:1",
            "observed_stream_id": STREAM,
            "observed_commit_seq": 0,
            "command": "example",
        }
    ).rstrip(b"\n")
    fixed = struct.pack(
        "<4sBBHIHH",
        WIRE_MAGIC,
        WIRE_MAJOR_VERSION,
        int(PacketKind.INPUT),
        0,
        len(header),
        1,
        0,
    )
    attachment = struct.pack(
        "<BBHI",
        int(AttachmentKind.INPUT_PAYLOAD),
        int(AttachmentEncoding.JSON),
        0,
        len(payload),
    )
    return fixed + header + attachment + payload


if __name__ == "__main__":
    main()
