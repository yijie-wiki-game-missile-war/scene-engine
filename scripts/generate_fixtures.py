#!/usr/bin/env python3
"""Regenerate the frozen cross-language Scene Engine wire@3/display@6 fixtures."""

from __future__ import annotations

import argparse
import json
import shutil
import struct
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from scene_engine.display import (  # noqa: E402
    DisplayCatalogIdentity,
    DisplayCommand,
    DisplayMatrixPool,
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
CATALOG_IDENTITY_FIELDS = {
    "scene_catalog_hash",
    "prefab_catalog_hash",
    "state_schema_hash",
}


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
    return DisplayTransform.from_matrix((
        1.0, 0.0, 0.0, 0.0,
        0.25, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        x, 0.0, 0.0, 1.0,
    ))


def catalog_identity_fixture() -> tuple[Path, bytes, DisplayCatalogIdentity]:
    """Validate the authored manifest and derive identity with production JS."""

    catalog_root = ROOT / "fixtures" / "display-catalog-v2"
    manifest_path = catalog_root / "manifest.json"
    identity_module = (
        ROOT / "js" / "packages" / "display" / "src" / "catalog" / "identity.js"
    )
    script = """
import { readFile } from 'node:fs/promises';
const {
  computeDisplayCatalogIdentity,
  defineDisplayCatalogManifest,
  toDisplayCatalogIdentityRecord,
} = await import(process.argv[2]);

const manifest = JSON.parse(await readFile(process.argv[3], 'utf8'));
const normalized = defineDisplayCatalogManifest(manifest);
const identity = computeDisplayCatalogIdentity(normalized);
process.stdout.write(JSON.stringify(toDisplayCatalogIdentityRecord(identity)));
"""
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-",
            identity_module.as_uri(),
            str(manifest_path),
        ],
        cwd=ROOT,
        input=script,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "Display catalog manifest validation failed:\n"
            f"{result.stderr.strip()}"
        )
    identity = json.loads(result.stdout)
    if set(identity) != CATALOG_IDENTITY_FIELDS or any(
        not isinstance(value, str) or len(value) != 64
        for value in identity.values()
    ):
        raise RuntimeError("Display catalog identity generator returned an invalid record")
    rendered = (
        json.dumps(identity, ensure_ascii=False, allow_nan=False, indent=2).encode("utf-8")
        + b"\n"
    )
    return (
        catalog_root / "identity.json",
        rendered,
        DisplayCatalogIdentity.from_record(identity),
    )


def node(
    node_id: int,
    *,
    parent_node_id: int | None = None,
    prefab_id: str = "unit.basic",
    visible: bool = True,
    state: dict | None = None,
) -> DisplayNode:
    return DisplayNode(
        node_id=node_id,
        parent_node_id=parent_node_id,
        prefab_id=prefab_id,
        transform_mode="live",
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
    catalog_identity_path, catalog_identity_bytes, catalog = catalog_identity_fixture()
    wire_root = ROOT / "fixtures" / "wire-v3"
    display_root = ROOT / "fixtures" / "display-v6"
    tree_root = ROOT / "fixtures" / "json-tree-v1"
    package_wire_root = ROOT / "js" / "packages" / "client" / "fixtures" / "wire-v3"
    package_log = ROOT / "js" / "packages" / "client" / "fixtures" / "packet-log"
    targets = [wire_root, display_root, tree_root]
    if not args.python_only:
        targets.append(package_wire_root)
        targets.append(package_log)
    for target in targets:
        reset(target)
    catalog_identity_path.write_bytes(catalog_identity_bytes)

    matrix_pool = DisplayMatrixPool()
    root_id = matrix_pool.append(transform(0.0))
    aircraft_id = matrix_pool.append(transform(0.0))
    doomed_id = matrix_pool.append(transform(-1.0))
    initial_nodes = (
        node(root_id),
        node(aircraft_id, parent_node_id=root_id),
        node(doomed_id, parent_node_id=root_id),
    )
    display_checkpoint = encode_display_checkpoint(
        scene_name="main",
        catalog=catalog,
        last_command_seq=0,
        matrix_pool=matrix_pool,
        nodes=initial_nodes,
    )
    display_checkpoint.confirm_published()
    transient_id = matrix_pool.append(transform(0.0))
    matrix_pool.set(aircraft_id, transform(1.5))
    matrix_pool.retire(doomed_id)
    commands = (
        DisplayCommand.create_node(
            node(transient_id, parent_node_id=root_id)
        ),
        DisplayCommand.set_transform(aircraft_id),
        DisplayCommand.set_parent(aircraft_id, root_id),
        DisplayCommand.set_visible(aircraft_id, False),
        DisplayCommand.set_state(aircraft_id, {"animation": "moving"}),
        DisplayCommand.replace_prefab(
            aircraft_id, "unit.basic", {"animation": "damaged"}
        ),
        DisplayCommand.remove(doomed_id),
    )
    display_tick, command_cursor = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        matrix_pool=matrix_pool,
        commands=commands,
    )
    display_tick.confirm_published()
    display_input, final_cursor = encode_display_command_stream(
        base_command_seq=command_cursor,
        source_tick=1,
        matrix_pool=matrix_pool,
        commands=(),
    )
    display_input.confirm_published()

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
        node(root_id),
        node(
            aircraft_id,
            parent_node_id=root_id,
            visible=False,
            state={"animation": "damaged"},
        ),
        node(transient_id, parent_node_id=root_id),
    )
    final_display_checkpoint = encode_display_checkpoint(
        scene_name="main",
        catalog=catalog,
        last_command_seq=final_cursor,
        matrix_pool=matrix_pool,
        nodes=final_nodes,
    )
    final_display_checkpoint.confirm_published()
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
    display_checkpoint_record = display_checkpoint.to_record()
    display_tick_record = display_tick.to_record()
    display_input_record = display_input.to_record()
    final_display_checkpoint_record = final_display_checkpoint.to_record()
    for name, data in {
        "checkpoint.json": display_checkpoint_record,
        "command-tick.json": display_tick_record,
        "command-input-empty.json": display_input_record,
        "periodic-checkpoint.json": final_display_checkpoint_record,
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
        canonical({"schema": "scene-engine-malformed-corpus@3", "files": sorted(malformed)})
    )
    malformed_display = {
        "command-sequence-gap.json": {
            **display_tick_record,
            "commands": [
                {**display_tick_record["commands"][0], "command_seq": 2},
                *display_tick_record["commands"][1:],
            ],
        },
        "command-source-tick.json": {
            **display_tick_record,
            "commands": [
                {**display_tick_record["commands"][0], "source_tick": 2},
                *display_tick_record["commands"][1:],
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
