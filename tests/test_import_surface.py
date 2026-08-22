from __future__ import annotations

import scene_engine
import scene_engine.presentation_frame as presentation_frame
import scene_engine.scene_bootstrap as scene_bootstrap
import scene_engine.runtime as runtime


def test_root_package_has_one_minimal_explicit_runtime_surface() -> None:
    assert scene_engine.__all__ == [
        "AuthorityCommitFatalError",
        "ConfigurationError",
        "ManualClock",
        "PresentationExportError",
        "RuntimeBusyError",
        "RuntimeConfig",
        "RuntimeStoppedError",
        "SceneEngineError",
        "SceneEngineRuntime",
        "SimulationFatalError",
    ]
    for internal_name in (
        "AuthorityCommitRequest",
        "PresentationNodeV3",
        "PresentationArchiveWriter",
        "PresentationIdAllocator",
        "encode_presentation_frame_v3",
        "parse_scene_bootstrap_v3",
    ):
        assert internal_name not in scene_engine.__dict__


def test_semantic_codec_modules_have_explicit_stable_exports() -> None:
    assert runtime.__all__ == [
        "AuthorityCommitCallback",
        "AuthorityCommitRequest",
        "FrameExportCallback",
        "PresentationExportRequest",
        "PumpResult",
        "RuntimeConfig",
        "RuntimeHealth",
        "SceneEngineRuntime",
    ]
    assert presentation_frame.__all__ == [
        "OpaquePayloadV3",
        "PresentationEventV3",
        "PresentationFrameHeaderV3",
        "PresentationFrameV3View",
        "PresentationNodeRecordV3",
        "PresentationNodeV3",
        "PresentationSectionEntryV3",
        "PresentationTreeValidationV3",
        "PresentationWorldPoseV3",
        "encode_presentation_frame_v3",
        "parse_presentation_frame_v3",
        "validate_presentation_frame_tree",
    ]
    assert scene_bootstrap.__all__ == [
        "AnimationStateRecordV3",
        "EngineSessionIdentityV3",
        "OpaquePayloadV3",
        "PresentationNodeRecordV3",
        "PresentationNodeV3",
        "PresentationSectionEntryV3",
        "PresentationTreeValidationV3",
        "PresentationWorldPoseV3",
        "SceneBootstrapHeaderV3",
        "SceneBootstrapV3View",
        "SceneMetadataV3",
        "VisualTypeRecordV3",
        "encode_scene_bootstrap_v3",
        "parse_scene_bootstrap_v3",
        "validate_presentation_node_tree",
    ]
