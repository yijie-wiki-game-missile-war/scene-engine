from __future__ import annotations

import inspect
import math
import struct
from pathlib import Path

import pytest

from scene_engine.wire import (
    AttachmentKind,
    DEFAULT_ENGINE_LIMITS,
    EngineLimits,
    MAXIMUM_SAFE_INTEGER,
    PacketKind,
    WireError,
    canonical_json_bytes,
    decode_json_bytes,
    encode_ack,
    encode_commit,
    encode_input,
    read_engine_packet,
)


FIXTURES = Path(__file__).parents[1] / "fixtures" / "wire-v1"


def test_default_wire_budget_covers_one_500_node_checkpoint_attachment() -> None:
    assert DEFAULT_ENGINE_LIMITS.maximum_packet_bytes == 64 * 1024 * 1024
    assert DEFAULT_ENGINE_LIMITS.maximum_attachment_bytes == 48 * 1024 * 1024
    assert DEFAULT_ENGINE_LIMITS.maximum_session_pending_bytes == 64 * 1024 * 1024


def test_decodes_frozen_python_to_js_golden_packets() -> None:
    expected = {
        "checkpoint.bin": PacketKind.CHECKPOINT,
        "commit-tick.bin": PacketKind.COMMIT,
        "commit-input.bin": PacketKind.COMMIT,
        "input.bin": PacketKind.INPUT,
        "ack.bin": PacketKind.ACK,
        "input-result.bin": PacketKind.INPUT_RESULT,
    }
    for name, kind in expected.items():
        raw = (FIXTURES / name).read_bytes()
        packet = read_engine_packet(raw)
        assert packet.kind is kind
        assert packet.raw_bytes == raw


def test_product_json_accepts_finite_float_boundaries_and_safe_integers() -> None:
    value = {
        "fraction": 1.5,
        "one": 1.0,
        "negative_zero": -0.0,
        "small": 1e-7,
        "large": 1e20,
        "maximum_integer": MAXIMUM_SAFE_INTEGER,
    }
    raw = canonical_json_bytes(value)
    decoded = decode_json_bytes(raw)
    assert decoded["fraction"] == 1.5
    assert decoded["one"] == 1.0
    assert math.copysign(1.0, decoded["negative_zero"]) == -1.0
    assert decoded["small"] == 1e-7
    assert decoded["large"] == 1e20
    assert decoded["maximum_integer"] == MAXIMUM_SAFE_INTEGER


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_product_json_rejects_nonfinite_numbers(value: float) -> None:
    with pytest.raises(WireError):
        canonical_json_bytes({"value": value})


def test_product_json_rejects_unsafe_integer_but_float_exponent_is_valid() -> None:
    with pytest.raises(WireError):
        canonical_json_bytes({"value": MAXIMUM_SAFE_INTEGER + 1})
    with pytest.raises(WireError):
        decode_json_bytes(b'{"value":9007199254740992}')
    assert decode_json_bytes(b'{"value":1e20}')["value"] == 1e20


def test_malformed_cross_language_corpus_fails_closed() -> None:
    for name in (
        "wrong-magic.bin",
        "truncated.bin",
        "trailing.bin",
        "unsafe-integer.bin",
        "nonfinite.bin",
    ):
        with pytest.raises(WireError):
            read_engine_packet((FIXTURES / name).read_bytes())


def test_header_fields_remain_nonnegative_safe_integers() -> None:
    with pytest.raises(WireError):
        encode_ack(stream_id="stream", commit_seq=1.5)  # type: ignore[arg-type]
    with pytest.raises(WireError):
        encode_ack(stream_id="stream", commit_seq=MAXIMUM_SAFE_INTEGER + 1)


def test_input_encoder_is_canonical_and_round_trips_float_payload() -> None:
    raw = encode_input(
        input_id="python:1",
        observed_stream_id="stream",
        observed_commit_seq=4,
        command="example",
        args={"fraction": 1.5, "small": 1e-7},
    )
    packet = read_engine_packet(raw)
    assert packet.header["observed_commit_seq"] == 4
    assert packet.attachments[0].value == {"fraction": 1.5, "small": 1e-7}


def test_custom_json_depth_limit_applies_to_packet_encode_and_decode() -> None:
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


def test_removed_product_event_attachment_kind_fails_closed() -> None:
    assert {int(kind) for kind in AttachmentKind} == {1, 2, 3, 4, 6, 7}
    assert "events" not in inspect.signature(encode_commit).parameters
    raw = bytearray((FIXTURES / "commit-input.bin").read_bytes())
    header_length = struct.unpack_from("<I", raw, 8)[0]
    raw[16 + header_length] = 5
    with pytest.raises(WireError, match="unknown"):
        read_engine_packet(raw)
