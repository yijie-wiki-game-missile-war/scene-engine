from __future__ import annotations

import pkgutil

import scene_engine


def test_python_root_exports_are_exact() -> None:
    assert set(scene_engine.__all__) == {
        "CheckpointContext",
        "CommitContext",
        "ConfigurationError",
        "EngineCommit",
        "EngineInput",
        "EngineProgram",
        "EngineRecorder",
        "EngineTransport",
        "InputContext",
        "JsonTreeError",
        "ManualClock",
        "MutationResult",
        "ProductCheckpoint",
        "ProductCommit",
        "PumpResult",
        "RecordingError",
        "RuntimeBusyError",
        "RuntimeConfig",
        "RuntimeFatalError",
        "RuntimeHealth",
        "RuntimeStateError",
        "SceneCodecError",
        "SceneEngineError",
        "SceneEngineRuntime",
        "SessionBackpressureError",
        "SessionError",
        "SystemMonotonicClock",
        "TickContext",
        "WireError",
        "WorldCounters",
        "__version__",
    }
    assert scene_engine.__version__ == "0.6.0"


def test_python_package_contains_only_current_modules() -> None:
    assert {module.name for module in pkgutil.iter_modules(scene_engine.__path__)} == {
        "clock",
        "errors",
        "json_tree",
        "recording",
        "runtime",
        "scene",
        "session",
        "wire",
    }
