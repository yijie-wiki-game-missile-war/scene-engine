# Agent Instructions

Before changing this repository, read `README.md` and the relevant current document in `docs/`.

`docs/runtime.md` is binding for simulation, scheduling, communication, recording, Replay, animation, and acceptance work.
The sole logical clock is an ordered integer tick at exactly 60 Hz. Every changed transaction is committed independently;
wall time and rendering never advance gameplay or animation state.

This directory is an independent repository. Keep product rules, product state schemas, network frameworks, HTTP, assets,
and product Prefab/Scene definitions outside it. Integrate through `EngineProgram`, wire/session/recorder ports,
`SceneEngineClient`, `DisplayRuntime`, and `RenderBackend`.

There is one mutable world owner, one Engine packet stream, one client WorldState pointer, one DisplayRuntime NodeIndex,
one local Transform per Node, one cumulative `(commitSeq,lastCommandSeq)` ACK cursor, and one packet-log format. Do not add
aliases, decoder fallbacks, parallel cursors, secondary Node stores, or a second scheduling clock.

Change protocol layouts and cross-language behavior together with Python tests, JavaScript tests, fixtures, package locks,
and current docs. Run `uv run python scripts/verify_cutover.py` (or an equivalent Python >=3.10 environment) before handoff.

Before changing Display scheduling, components, health/rebuild, resource contracts, the Three backend, or acceptance evidence,
read `docs/display.md` and `docs/render-runtime.md`. The backend must remain a flat public port: it owns renderer resources
and bindings but no business Node graph, controls loop, product callback, implicit light, or caller-visible Three object.
