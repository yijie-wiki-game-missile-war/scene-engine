from __future__ import annotations

import hashlib
import pickle
import struct
from dataclasses import asdict, fields, replace
from pathlib import Path
from types import MappingProxyType

import pytest

import scene_engine.scene as scene_module
from scene_engine.errors import SceneCodecError
from scene_engine.scene import (
    AnimationState,
    OpaquePayload,
    SceneBootstrapView,
    SceneEvent,
    SceneNode,
    VisualType,
    encode_scene_bootstrap,
    encode_scene_frame,
    encode_scene_frame_against_bootstrap,
    parse_scene_bootstrap,
    parse_scene_frame,
    validate_scene_tree,
)


FIXTURES = Path(__file__).parents[1] / "fixtures" / "scene-v1"
SCENE_FIXTURE_SHA256 = {
    "bootstrap.bin": "b0a188494c22508b400d43024a8b4a391eb7157e4ed48685c92cfba3be0e7370",
    "frame-0.bin": "9681db27bf52362390a3d1c5f9c4954184c2d01118547309993cffdbff1229e2",
    "frame-1.bin": "abacf13c1c163de2f7220d014041ffb2192cffa93659fd7e7478dd68cdd1c39c",
}


def node(
    identity: int,
    parent: int = 0,
    *,
    x: float = 0.0,
    animation_state_id: int = 0,
) -> SceneNode:
    return SceneNode(
        identity,
        parent,
        1,
        1,
        (x, 0.0, 0.0),
        (0.0, 0.0, 0.0, 1.0),
        (1.0, 1.0, 1.0),
        animation_state_id,
    )


def patched_bootstrap_record(
    raw: bytes,
    *,
    section: int,
    record: int,
    field_offset: int,
    format: str,
    value: int,
) -> bytes:
    parsed = parse_scene_bootstrap(raw)
    entry = parsed.directory[section]
    mutable = bytearray(raw)
    struct.pack_into(
        format,
        mutable,
        entry.byte_offset + record * entry.record_stride + field_offset,
        value,
    )
    hash_offset = struct.calcsize("<HHHHHHfIIII")
    mutable[hash_offset : hash_offset + 32] = hashlib.sha256(
        mutable[parsed.header.header_bytes :]
    ).digest()
    return bytes(mutable)


def test_python_and_javascript_share_scene_body_layout() -> None:
    bootstrap = parse_scene_bootstrap((FIXTURES / "bootstrap.bin").read_bytes())
    frame = parse_scene_frame((FIXTURES / "frame-1.bin").read_bytes(), source_tick=1)
    assert bootstrap.visual_types == (VisualType(1),)
    assert frame.nodes[0].local_position == (1.5, 0.0, 0.0)
    assert frame.events[0].payload == b"tick"


def test_frozen_bootstrap_fixture_sha_and_parse_reencode_are_exact() -> None:
    raw = (FIXTURES / "bootstrap.bin").read_bytes()
    assert hashlib.sha256(raw).hexdigest() == SCENE_FIXTURE_SHA256["bootstrap.bin"]
    bootstrap = parse_scene_bootstrap(raw)

    assert encode_scene_bootstrap(
        maximum_dynamic_nodes=bootstrap.header.maximum_dynamic_nodes,
        maximum_frame_bytes=bootstrap.header.maximum_frame_bytes,
        static_nodes=bootstrap.static_nodes,
        scene_metadata=bootstrap.scene_metadata,
        visual_types=bootstrap.visual_types,
        animation_states=bootstrap.animation_states,
        ticks_per_second=bootstrap.header.ticks_per_second,
        coordinate_profile=bootstrap.header.coordinate_profile,
        world_units_per_meter=bootstrap.header.world_units_per_meter,
    ) == raw


@pytest.mark.parametrize(
    ("name", "source_tick"),
    (("frame-0.bin", 0), ("frame-1.bin", 1)),
)
def test_frozen_frame_fixture_sha_and_parse_reencode_are_exact(
    name: str,
    source_tick: int,
) -> None:
    raw = (FIXTURES / name).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == SCENE_FIXTURE_SHA256[name]
    frame = parse_scene_frame(raw, source_tick=source_tick)

    assert encode_scene_frame(
        source_tick=source_tick,
        nodes=frame.nodes,
        events=frame.events,
    ) == raw


def test_bootstrap_and_complete_frame_are_deterministic() -> None:
    bootstrap = encode_scene_bootstrap(
        maximum_dynamic_nodes=8,
        maximum_frame_bytes=4096,
        visual_types=(VisualType(1),),
    )
    frame = encode_scene_frame(source_tick=4, nodes=(node(1), node(2, 1, x=2.0)))
    assert parse_scene_bootstrap(bootstrap).header.ticks_per_second == 60
    parsed = parse_scene_frame(frame, source_tick=4)
    poses = validate_scene_tree(parsed.nodes)
    assert poses[2][0] == 2.0


def test_structured_publication_validates_against_cached_bootstrap_and_encodes_once() -> None:
    bootstrap = parse_scene_bootstrap(
        encode_scene_bootstrap(
            maximum_dynamic_nodes=2,
            maximum_frame_bytes=4096,
            visual_types=(VisualType(1),),
        )
    )
    records = (node(1), node(2, 1, x=2.0))
    assert encode_scene_frame_against_bootstrap(
        source_tick=4,
        nodes=records,
        bootstrap=bootstrap,
    ) == encode_scene_frame(source_tick=4, nodes=records)

    with pytest.raises(SceneCodecError, match="visual type"):
        encode_scene_frame_against_bootstrap(
            source_tick=4,
            nodes=(
                SceneNode(
                    1,
                    0,
                    2,
                    1,
                    (0.0, 0.0, 0.0),
                    (0.0, 0.0, 0.0, 1.0),
                    (1.0, 1.0, 1.0),
                ),
            ),
            bootstrap=bootstrap,
        )


def test_structured_publication_enforces_bootstrap_node_and_byte_limits() -> None:
    node_limited = parse_scene_bootstrap(
        encode_scene_bootstrap(
            maximum_dynamic_nodes=1,
            maximum_frame_bytes=4096,
            visual_types=(VisualType(1),),
        )
    )
    with pytest.raises(SceneCodecError, match="node limit"):
        encode_scene_frame_against_bootstrap(
            source_tick=0,
            nodes=(node(1), node(2)),
            bootstrap=node_limited,
        )

    with pytest.raises(SceneCodecError, match="byte limit"):
        encode_scene_frame_against_bootstrap(
            source_tick=0,
            nodes=(node(1),),
            bootstrap=node_limited,
            maximum_frame_bytes=1,
        )


@pytest.mark.parametrize(
    "nodes",
    [
        (node(1, 99),),
        (node(1, 2), node(2, 1)),
    ],
)
def test_dangling_parent_and_cycle_fail_closed(nodes) -> None:
    with pytest.raises(SceneCodecError):
        validate_scene_tree(nodes)


def test_registry_payload_type_is_enforced() -> None:
    bad = SceneNode(
        1,
        0,
        1,
        1,
        (0.0, 0.0, 0.0),
        (0.0, 0.0, 0.0, 1.0),
        (1.0, 1.0, 1.0),
        profile=OpaquePayload(2, b"x"),
    )
    with pytest.raises(SceneCodecError):
        encode_scene_bootstrap(
            maximum_dynamic_nodes=1,
            maximum_frame_bytes=4096,
            static_nodes=(bad,),
            visual_types=(VisualType(1, profile_type_id=1),),
        )


def test_bootstrap_parse_builds_read_only_non_dataclass_indexes() -> None:
    raw = encode_scene_bootstrap(
        maximum_dynamic_nodes=4,
        maximum_frame_bytes=4096,
        static_nodes=(node(100), node(101, 100)),
        visual_types=(VisualType(1),),
        animation_states=(AnimationState(1, 0, 60),),
    )
    bootstrap = parse_scene_bootstrap(raw)

    assert isinstance(bootstrap._visual_by_id, MappingProxyType)
    assert isinstance(bootstrap._static_by_id, MappingProxyType)
    assert isinstance(bootstrap._static_depth_by_id, MappingProxyType)
    assert bootstrap._animation_ids == frozenset((1,))
    assert bootstrap._static_depth_by_id == {100: 1, 101: 2}
    assert bootstrap._maximum_static_depth == 2
    assert all(not item.name.startswith("_") for item in fields(bootstrap))
    assert all(not key.startswith("_") for key in asdict(bootstrap))
    assert "_visual_by_id" not in repr(bootstrap)
    with pytest.raises(TypeError):
        bootstrap._static_by_id[102] = node(102)  # type: ignore[index]
    with pytest.raises(TypeError, match="parse-only"):
        SceneBootstrapView()

    restored = pickle.loads(pickle.dumps(bootstrap))
    assert restored == bootstrap
    assert hash(restored) == hash(bootstrap)
    assert isinstance(restored._visual_by_id, MappingProxyType)


def test_parse_bootstrap_strictly_validates_static_graph_and_registries() -> None:
    raw = encode_scene_bootstrap(
        maximum_dynamic_nodes=4,
        maximum_frame_bytes=4096,
        static_nodes=(
            node(100, animation_state_id=1),
            node(101, 100, animation_state_id=1),
        ),
        visual_types=(VisualType(1),),
        animation_states=(AnimationState(1, 0, 60),),
    )
    node_animation_offset = struct.calcsize("<QQII3f4f3f")
    malformed = (
        patched_bootstrap_record(
            raw,
            section=0,
            record=1,
            field_offset=0,
            format="<Q",
            value=100,
        ),
        patched_bootstrap_record(
            raw,
            section=0,
            record=0,
            field_offset=8,
            format="<Q",
            value=999,
        ),
        patched_bootstrap_record(
            raw,
            section=0,
            record=0,
            field_offset=8,
            format="<Q",
            value=101,
        ),
        patched_bootstrap_record(
            raw,
            section=0,
            record=0,
            field_offset=16,
            format="<I",
            value=2,
        ),
        patched_bootstrap_record(
            raw,
            section=0,
            record=0,
            field_offset=node_animation_offset,
            format="<I",
            value=2,
        ),
    )
    for body in malformed:
        with pytest.raises(SceneCodecError):
            parse_scene_bootstrap(body)

    with pytest.raises(SceneCodecError, match="maximum_depth"):
        parse_scene_bootstrap(raw, maximum_tree_depth=1)


def test_bootstrap_payload_type_validation_fails_closed() -> None:
    invalid_python_value = replace(node(100), profile=b"not-opaque")
    with pytest.raises(SceneCodecError, match="OpaquePayload"):
        encode_scene_bootstrap(
            maximum_dynamic_nodes=1,
            maximum_frame_bytes=4096,
            static_nodes=(invalid_python_value,),
            visual_types=(VisualType(1, profile_type_id=1),),
        )

    raw = encode_scene_bootstrap(
        maximum_dynamic_nodes=1,
        maximum_frame_bytes=4096,
        static_nodes=(
            replace(node(100), profile=OpaquePayload(1, b"profile")),
        ),
        visual_types=(VisualType(1, profile_type_id=1),),
    )
    mismatched = patched_bootstrap_record(
        raw,
        section=1,
        record=0,
        field_offset=8,
        format="<I",
        value=2,
    )
    with pytest.raises(SceneCodecError, match="payload type"):
        parse_scene_bootstrap(mismatched)


def test_dynamic_parent_chains_validate_only_against_cached_static_depths() -> None:
    bootstrap = parse_scene_bootstrap(
        encode_scene_bootstrap(
            maximum_dynamic_nodes=4,
            maximum_frame_bytes=4096,
            static_nodes=(node(100), node(101, 100)),
            visual_types=(VisualType(1),),
            animation_states=(AnimationState(1, 0, 60),),
        )
    )
    valid = (
        node(1, 101, animation_state_id=1),
        node(2, 1, animation_state_id=1),
    )
    assert encode_scene_frame_against_bootstrap(
        source_tick=4,
        nodes=valid,
        bootstrap=bootstrap,
    ) == encode_scene_frame(source_tick=4, nodes=valid)

    failures = (
        (node(1, 999),),
        (node(100),),
        (node(1, 2), node(2, 1)),
        (replace(node(1, 101), visual_type_id=2),),
        (node(1, 101, animation_state_id=2),),
    )
    for records in failures:
        with pytest.raises(SceneCodecError):
            encode_scene_frame_against_bootstrap(
                source_tick=4,
                nodes=records,
                bootstrap=bootstrap,
            )

    with pytest.raises(SceneCodecError, match="maximum_depth"):
        encode_scene_frame_against_bootstrap(
            source_tick=4,
            nodes=(node(1, 2), node(2, 101)),
            bootstrap=bootstrap,
            maximum_depth=3,
        )


def test_frame_hot_path_does_not_call_complete_tree_or_pose_helpers(
    monkeypatch,
) -> None:
    static_nodes = tuple(
        node(10_000 + offset, 0 if offset <= 8 else 10_001 + (offset % 8))
        for offset in range(1, 633)
    )
    bootstrap = parse_scene_bootstrap(
        encode_scene_bootstrap(
            maximum_dynamic_nodes=500,
            maximum_frame_bytes=1024 * 1024,
            static_nodes=static_nodes,
            visual_types=(VisualType(1),),
        )
    )
    dynamic_nodes = tuple(
        node(identity, 10_001 + (identity % 8)) for identity in range(1, 501)
    )

    def forbidden(*args, **kwargs):
        del args, kwargs
        raise AssertionError("complete static tree/pose helper entered hot path")

    class IterationTrap:
        def __iter__(self):
            raise AssertionError("static/bootstrap source tuple was iterated")

    monkeypatch.setattr(scene_module, "_validate_tree", forbidden)
    monkeypatch.setattr(scene_module, "_compose_pose", forbidden)
    object.__setattr__(bootstrap, "static_nodes", IterationTrap())
    object.__setattr__(bootstrap, "visual_types", IterationTrap())
    object.__setattr__(bootstrap, "animation_states", IterationTrap())

    assert encode_scene_frame_against_bootstrap(
        source_tick=1,
        nodes=dynamic_nodes,
        bootstrap=bootstrap,
    ) == encode_scene_frame(source_tick=1, nodes=dynamic_nodes)


def test_frame_hot_path_structure_counters_are_zero(monkeypatch) -> None:
    static_nodes = tuple(node(1000 + identity) for identity in range(1, 9))
    bootstrap = parse_scene_bootstrap(
        encode_scene_bootstrap(
            maximum_dynamic_nodes=500,
            maximum_frame_bytes=1024 * 1024,
            static_nodes=static_nodes,
            visual_types=(VisualType(1),),
            animation_states=(AnimationState(1, 0, 60),),
        )
    )
    dynamic_nodes = tuple(
        node(identity, 1001 + (identity % 8), animation_state_id=1)
        for identity in range(1, 501)
    )
    counts = {
        "static_node_iteration": 0,
        "visual_source_iteration": 0,
        "animation_source_iteration": 0,
        "visual_index_iteration": 0,
        "animation_index_iteration": 0,
        "static_index_iteration": 0,
        "static_depth_index_iteration": 0,
        "pose_composition": 0,
        "cached_index_lookups": 0,
    }

    class CountedIterable:
        def __init__(self, values, counter):
            self.values = values
            self.counter = counter

        def __iter__(self):
            counts[self.counter] += 1
            return iter(self.values)

    class CountedMapping:
        def __init__(self, values, counter):
            self.values = values
            self.counter = counter

        def __len__(self):
            return len(self.values)

        def __iter__(self):
            counts[self.counter] += 1
            return iter(self.values)

        def __contains__(self, key):
            counts["cached_index_lookups"] += 1
            return key in self.values

        def __getitem__(self, key):
            counts["cached_index_lookups"] += 1
            return self.values[key]

        def get(self, key, default=None):
            counts["cached_index_lookups"] += 1
            return self.values.get(key, default)

    class CountedSet:
        def __init__(self, values):
            self.values = values

        def __iter__(self):
            counts["animation_index_iteration"] += 1
            return iter(self.values)

        def __contains__(self, key):
            counts["cached_index_lookups"] += 1
            return key in self.values

    original_compose = scene_module._compose_pose

    def counted_compose(*args, **kwargs):
        counts["pose_composition"] += 1
        return original_compose(*args, **kwargs)

    monkeypatch.setattr(scene_module, "_compose_pose", counted_compose)
    object.__setattr__(
        bootstrap,
        "static_nodes",
        CountedIterable(bootstrap.static_nodes, "static_node_iteration"),
    )
    object.__setattr__(
        bootstrap,
        "visual_types",
        CountedIterable(bootstrap.visual_types, "visual_source_iteration"),
    )
    object.__setattr__(
        bootstrap,
        "animation_states",
        CountedIterable(
            bootstrap.animation_states, "animation_source_iteration"
        ),
    )
    object.__setattr__(
        bootstrap,
        "_visual_by_id",
        CountedMapping(bootstrap._visual_by_id, "visual_index_iteration"),
    )
    object.__setattr__(
        bootstrap,
        "_animation_ids",
        CountedSet(bootstrap._animation_ids),
    )
    object.__setattr__(
        bootstrap,
        "_static_by_id",
        CountedMapping(bootstrap._static_by_id, "static_index_iteration"),
    )
    object.__setattr__(
        bootstrap,
        "_static_depth_by_id",
        CountedMapping(
            bootstrap._static_depth_by_id,
            "static_depth_index_iteration",
        ),
    )

    encode_scene_frame_against_bootstrap(
        source_tick=1,
        nodes=dynamic_nodes,
        bootstrap=bootstrap,
    )

    assert counts == {
        "static_node_iteration": 0,
        "visual_source_iteration": 0,
        "animation_source_iteration": 0,
        "visual_index_iteration": 0,
        "animation_index_iteration": 0,
        "static_index_iteration": 0,
        "static_depth_index_iteration": 0,
        "pose_composition": 0,
        "cached_index_lookups": counts["cached_index_lookups"],
    }
    assert counts["cached_index_lookups"] > 0


def test_optimized_frame_bytes_match_generic_encoder_for_all_workloads() -> None:
    bootstrap_raw = encode_scene_bootstrap(
        maximum_dynamic_nodes=500,
        maximum_frame_bytes=1024 * 1024,
        static_nodes=(node(1000),),
        visual_types=(VisualType(1),),
    )
    bootstrap = parse_scene_bootstrap(bootstrap_raw)
    steady = tuple(node(identity, 1000) for identity in range(1, 501))
    motion = tuple(replace(item, local_position=(1.5, 2.5, 3.5)) for item in steady)
    churn = tuple(
        replace(item, display_id=10_000 + item.display_id)
        if item.display_id <= 25
        else item
        for item in steady
    )
    churn = tuple(sorted(churn, key=lambda item: item.display_id))
    event = SceneEvent(1, 1, 0, 1, 0, 9, b"same-bytes")

    for records in (steady, motion, churn):
        optimized = encode_scene_frame_against_bootstrap(
            source_tick=9,
            nodes=records,
            events=(event,),
            bootstrap=bootstrap,
        )
        assert optimized == encode_scene_frame(
            source_tick=9,
            nodes=records,
            events=(event,),
        )
    assert encode_scene_bootstrap(
        maximum_dynamic_nodes=500,
        maximum_frame_bytes=1024 * 1024,
        static_nodes=(node(1000),),
        visual_types=(VisualType(1),),
    ) == bootstrap_raw
