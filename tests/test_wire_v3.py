from __future__ import annotations

import struct
import inspect
import math
import json
from pathlib import Path

import pytest

from scene_engine.display import (
    DISPLAY_CODEC,
    DisplayCatalogIdentity,
    DisplayCommand,
    DisplayNode,
    DisplayTransform,
    encode_display_checkpoint,
    encode_display_command_stream,
    validate_display_checkpoint,
    validate_display_command_stream,
)
from scene_engine.display_binary import (
    decode_display_checkpoint_binary,
    decode_display_command_stream_binary,
)


FIXTURES = Path(__file__).parents[1] / "fixtures"
from scene_engine.errors import ConfigurationError, WireError
from scene_engine.wire import (
    AttachmentKind,
    DEFAULT_ENGINE_LIMITS,
    EngineLimits,
    MAXIMUM_SAFE_INTEGER,
    PacketKind,
    WIRE_MAJOR_VERSION,
    WIRE_SCHEMA,
    canonical_json_bytes,
    decode_json_bytes,
    encode_ack,
    encode_checkpoint,
    encode_commit,
    encode_input,
    read_engine_packet,
)


def display_node() -> DisplayNode:
    return DisplayNode(
        name="py/aircraft-17",
        parent_name=None,
        prefab_id="flight.aircraft",
        transform_mode="live",
        transform=DisplayTransform.identity(),
        visible=True,
        state={"animation": "idle"},
    )


def test_wire_v3_checkpoint_contains_world_and_binary_display_baseline_only() -> None:
    display = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity("a" * 64, "b" * 64, "c" * 64),
        last_command_seq=0,
        nodes=(display_node(),),
    )
    raw = encode_checkpoint(
        stream_id="stream-1",
        commit_seq=0,
        source_tick=0,
        world_revision=0,
        last_command_seq=0,
        world_codec="world@1",
        world_snapshot={"schema": "world@1"},
        display_checkpoint=display,
    )
    packet = read_engine_packet(raw)

    assert raw[4] == WIRE_MAJOR_VERSION == 3
    assert packet.kind is PacketKind.CHECKPOINT
    assert packet.header["schema"] == WIRE_SCHEMA == "scene-engine-wire@3"
    assert packet.header["display_codec"] == DISPLAY_CODEC == "scene-engine-display-node@5"
    assert [item.kind for item in packet.attachments] == [
        AttachmentKind.WORLD_SNAPSHOT,
        AttachmentKind.DISPLAY_CHECKPOINT,
    ]
    assert packet.attachments[1].encoding.name == "RAW"
    assert packet.attachments[1].bytes.startswith(b"SDCP")


def test_frozen_wire_v3_golden_packets_round_trip_exact_bytes() -> None:
    expected = {
        "checkpoint.bin": PacketKind.CHECKPOINT,
        "commit-tick.bin": PacketKind.COMMIT,
        "commit-input.bin": PacketKind.COMMIT,
        "input.bin": PacketKind.INPUT,
        "ack.bin": PacketKind.ACK,
        "input-result.bin": PacketKind.INPUT_RESULT,
    }
    for name, kind in expected.items():
        raw = (FIXTURES / "wire-v3" / name).read_bytes()
        packet = read_engine_packet(raw)
        assert packet.kind is kind
        assert packet.raw_bytes == raw

    checkpoint = read_engine_packet((FIXTURES / "wire-v3/checkpoint.bin").read_bytes())
    display = decode_display_checkpoint_binary(
        checkpoint.attachments[1].bytes,
        checkpoint.header["last_command_seq"],
    )
    identity = json.loads(
        (FIXTURES / "display-catalog-v2/identity.json").read_text()
    )
    assert {
        "scene_catalog_hash": display["scene_catalog_hash"],
        "prefab_catalog_hash": display["prefab_catalog_hash"],
        "state_schema_hash": display["state_schema_hash"],
    } == identity


def test_frozen_display_v5_corpus_validates_and_malformed_records_fail() -> None:
    root = FIXTURES / "display-v5"
    checkpoint_value = json.loads((root / "checkpoint.json").read_text())
    command_value = json.loads((root / "command-tick.json").read_text())
    nodes = validate_display_checkpoint(checkpoint_value)
    commands = validate_display_command_stream(
        command_value,
        expected_source_tick=1,
        expected_last_command_seq=7,
    )
    assert len(nodes) == 2
    assert nodes[0].transform.matrix[4] == 0.25
    assert len(commands) == 7
    assert commands[1].fields["transform"].matrix[4] == 0.25
    assert commands[1].fields["transform"].matrix[12] == 1.5
    for name in ("command-sequence-gap.json", "command-source-tick.json"):
        malformed = json.loads((root / name).read_text())
        with pytest.raises(ConfigurationError):
            validate_display_command_stream(
                malformed,
                expected_source_tick=1,
                expected_last_command_seq=7,
            )


def test_frozen_wire_v3_malformed_corpus_fails_closed() -> None:
    root = FIXTURES / "wire-v3"
    manifest = json.loads((root / "malformed-manifest.json").read_text())
    assert manifest["schema"] == "scene-engine-malformed-corpus@3"
    for name in manifest["files"]:
        with pytest.raises(WireError):
            read_engine_packet((root / name).read_bytes())


def test_wire_v3_commit_always_contains_a_binary_command_stream_seal() -> None:
    stream, cursor = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        commands=(DisplayCommand.set_visible("py/aircraft-17", False),),
    )
    raw = encode_commit(
        stream_id="stream-1",
        commit_seq=1,
        source_tick=1,
        world_revision=1,
        last_command_seq=cursor,
        cause="tick",
        causation_id=None,
        world_codec="world@1",
        world_patch={"schema": "scene-engine-json-tree@1", "changes": []},
        display_commands=stream,
    )
    packet = read_engine_packet(raw)

    assert cursor == 1
    assert packet.kind is PacketKind.COMMIT
    assert packet.attachments[1].kind is AttachmentKind.DISPLAY_COMMAND_STREAM
    assert packet.attachments[1].encoding.name == "RAW"
    decoded = decode_display_command_stream_binary(
        packet.attachments[1].bytes,
        expected_source_tick=1,
        expected_last_command_seq=1,
    )
    assert decoded["commands"][0]["name"] == "py/aircraft-17"


def test_validated_stream_fast_path_is_byte_exact_and_plain_data_stays_fail_closed() -> None:
    stream, cursor = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        commands=(DisplayCommand.set_transform("py/aircraft-17", DisplayTransform.identity()),),
    )
    plain_stream = stream.to_record()

    def encoded(display_commands):
        return encode_commit(
            stream_id="stream-1",
            commit_seq=1,
            source_tick=1,
            world_revision=1,
            last_command_seq=cursor,
            cause="tick",
            causation_id=None,
            world_codec="world@1",
            world_patch={"schema": "scene-engine-json-tree@1", "changes": []},
            display_commands=display_commands,
        )

    assert encoded(stream) == encoded(plain_stream)
    plain_stream["commands"][0]["source_tick"] = 2
    with pytest.raises(WireError, match="display attachment"):
        encoded(plain_stream)


def test_wire_v2_major_is_rejected_without_a_compatibility_decoder() -> None:
    display = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity("a" * 64, "b" * 64, "c" * 64),
        last_command_seq=0,
        nodes=(),
    )
    raw = bytearray(
        encode_checkpoint(
            stream_id="stream-1",
            commit_seq=0,
            source_tick=0,
            world_revision=0,
            last_command_seq=0,
            world_codec="world@1",
            world_snapshot={"schema": "world@1"},
            display_checkpoint=display,
        )
    )
    raw[4] = 2
    with pytest.raises(WireError, match="version"):
        read_engine_packet(raw)


def test_old_json_display_attachment_layout_is_rejected() -> None:
    display = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity("a" * 64, "b" * 64, "c" * 64),
        last_command_seq=0,
        nodes=(),
    )
    raw = bytearray(
        encode_checkpoint(
            stream_id="stream-1",
            commit_seq=0,
            source_tick=0,
            world_revision=0,
            last_command_seq=0,
            world_codec="world@1",
            world_snapshot={"schema": "world@1"},
            display_checkpoint=display,
        )
    )
    header_length = struct.unpack_from("<I", raw, 8)[0]
    first_attachment = 16 + header_length
    first_length = struct.unpack_from("<I", raw, first_attachment + 4)[0]
    second_attachment = first_attachment + 8 + first_length
    raw[second_attachment + 1] = 1
    with pytest.raises(WireError, match="attachment"):
        read_engine_packet(raw)


def test_wire_budgets_cover_a_500_node_display_checkpoint() -> None:
    assert DEFAULT_ENGINE_LIMITS.maximum_packet_bytes == 64 * 1024 * 1024
    assert DEFAULT_ENGINE_LIMITS.maximum_attachment_bytes == 48 * 1024 * 1024
    assert DEFAULT_ENGINE_LIMITS.maximum_session_pending_bytes == 64 * 1024 * 1024


def test_json_subset_accepts_finite_values_and_rejects_unsafe_numbers() -> None:
    value = {
        "fraction": 1.5,
        "negative_zero": -0.0,
        "small": 1e-7,
        "large": 1e20,
        "maximum_integer": MAXIMUM_SAFE_INTEGER,
    }
    decoded = decode_json_bytes(canonical_json_bytes(value))
    assert decoded["fraction"] == 1.5
    assert math.copysign(1.0, decoded["negative_zero"]) == -1.0
    assert decoded["maximum_integer"] == MAXIMUM_SAFE_INTEGER
    for number in (math.nan, math.inf, -math.inf):
        with pytest.raises(WireError):
            canonical_json_bytes({"value": number})
    with pytest.raises(WireError):
        canonical_json_bytes({"value": MAXIMUM_SAFE_INTEGER + 1})
    with pytest.raises(WireError):
        decode_json_bytes(b'{"value":9007199254740992}')


def test_header_command_cursor_is_a_nonnegative_safe_integer() -> None:
    for value in (1.5, MAXIMUM_SAFE_INTEGER + 1, True):
        with pytest.raises(WireError):
            encode_ack(
                stream_id="stream",
                commit_seq=1,
                last_command_seq=value,  # type: ignore[arg-type]
            )


def test_input_json_depth_limit_applies_to_encode_and_decode() -> None:
    limits = EngineLimits(maximum_json_depth=1)
    with pytest.raises(WireError):
        encode_input(
            input_id="python:deep",
            observed_stream_id="stream",
            observed_commit_seq=0,
            command="example",
            args={"nested": {"value": 1}},
            limits=limits,
        )
    raw = encode_input(
        input_id="python:deep",
        observed_stream_id="stream",
        observed_commit_seq=0,
        command="example",
        args={"nested": {"value": 1}},
    )
    with pytest.raises(WireError):
        read_engine_packet(raw, limits=limits)


def test_display_stream_cursor_and_tick_must_match_packet_header() -> None:
    stream, cursor = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        commands=(DisplayCommand.set_visible("py/aircraft-17", False),),
    )
    raw = encode_commit(
        stream_id="stream-1",
        commit_seq=1,
        source_tick=1,
        world_revision=1,
        last_command_seq=cursor,
        cause="tick",
        causation_id=None,
        world_codec="world@1",
        world_patch={"schema": "scene-engine-json-tree@1", "changes": []},
        display_commands=stream,
    )
    header_length = struct.unpack_from("<I", raw, 8)[0]
    first_attachment = 16 + header_length
    first_length = struct.unpack_from("<I", raw, first_attachment + 4)[0]
    second_attachment = first_attachment + 8 + first_length
    display_payload = second_attachment + 8
    malformed_packets = [
        raw.replace(b'"last_command_seq":1', b'"last_command_seq":0', 1),
        raw.replace(b'"source_tick":1', b'"source_tick":2', 1),
    ]
    malformed_base = bytearray(raw)
    struct.pack_into("<Q", malformed_base, display_payload + 8, 1)
    malformed_packets.append(bytes(malformed_base))
    for malformed in malformed_packets:
        assert malformed != raw
        with pytest.raises(WireError):
            read_engine_packet(malformed)


def test_removed_event_attachment_kind_fails_closed() -> None:
    assert {int(kind) for kind in AttachmentKind} == {1, 2, 3, 4, 6, 7}
    assert "events" not in inspect.signature(encode_commit).parameters
    stream, cursor = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        commands=(),
    )
    raw = bytearray(
        encode_commit(
            stream_id="stream-1",
            commit_seq=1,
            source_tick=1,
            world_revision=1,
            last_command_seq=cursor,
            cause="tick",
            causation_id=None,
            world_codec="world@1",
            world_patch={"schema": "scene-engine-json-tree@1", "changes": []},
            display_commands=stream,
        )
    )
    header_length = struct.unpack_from("<I", raw, 8)[0]
    raw[16 + header_length] = 5
    with pytest.raises(WireError, match="unknown"):
        read_engine_packet(raw)
