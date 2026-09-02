from __future__ import annotations

import pkgutil

import scene_engine
import scene_engine.display_binary as display_binary


def test_python_root_exports_are_exact() -> None:
    assert set(scene_engine.__all__) == {
        "CheckpointContext",
        "CommitContext",
        "ConfigurationError",
        "DisplayCommand",
        "DisplayMatrixPool",
        "DisplayNode",
        "DisplayTransform",
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
        "SceneEngineError",
        "SceneEngineRuntime",
        "TICKS_PER_SECOND",
        "SessionBackpressureError",
        "SessionError",
        "SystemMonotonicClock",
        "TickContext",
        "WireError",
        "WorldCounters",
        "__version__",
    }
    assert scene_engine.__version__ == "0.19.0"


def test_python_package_contains_only_current_modules() -> None:
    assert {module.name for module in pkgutil.iter_modules(scene_engine.__path__)} == {
        "clock",
        "display",
        "display_binary",
        "errors",
        "json_tree",
        "recording",
        "runtime",
        "session",
        "transport_sender",
        "wire",
    }


def test_display_binary_star_exports_are_exact_and_resolvable() -> None:
    namespace: dict[str, object] = {}
    exec("from scene_engine.display_binary import *", namespace)

    assert set(namespace) - {"__builtins__"} == set(display_binary.__all__)
