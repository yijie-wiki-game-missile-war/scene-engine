# Agent Instructions

Before changing this repository, read `README.md` and the relevant current document in `docs/`.
For practical use, integration, extension, testing, or debugging, also read `.agents/skills/scene-engine/SKILL.md`; it routes work to the correct public boundary and does not cover game-art production.

`docs/runtime.md` is binding for simulation, scheduling, communication, recording, Replay, animation, and acceptance work.
The sole logical clock is an ordered integer tick at exactly 60 Hz. Keep the value variable-driven through
`TICKS_PER_SECOND`, `RuntimeConfig.ticks_per_second`, and runtime contexts, but do not make another rate legal. Every changed
transaction is committed independently. Wall time and rendering never advance gameplay state or simulation-authoritative
animation state; explicitly visual-only animation may sample `visualSeconds` but must never mutate World state.

This directory is an independent repository. Keep product rules, product state schemas, network frameworks, HTTP, assets,
and product Prefab/Scene definitions outside it. Integrate through `EngineProgram`, wire/session/recorder ports,
`SceneEngineClient`, `DisplayRuntime`, and `RenderBackend`.

There is one mutable world owner, one Engine packet stream, one client WorldState pointer, one DisplayRuntime NodeIndex,
one local Transform per Node, one cumulative `(commitSeq,lastCommandSeq)` ACK cursor, and one packet-log format. Do not add
aliases, decoder fallbacks, parallel cursors, secondary Node stores, or a second scheduling clock.

Change protocol layouts and cross-language behavior together with Python tests, JavaScript tests, fixtures, package locks,
and current docs. Root `npm test` includes the strict Client/Display/renderer-three declaration interop check. Run it and
`uv run python scripts/verify_cutover.py` (or an equivalent Python >=3.10 environment) before handoff.

Before changing Display scheduling, components, health/rebuild, resource contracts, the Three backend, or acceptance evidence,
read `docs/display.md` and `docs/render-runtime.md`. The backend must remain a flat public port: it owns renderer resources
and bindings but no business Node graph, controls loop, product callback, implicit light, or caller-visible Three object.

After Display activation, every Python-authority mutation must occur inside the active Client commit gate; pre-activation
mutation is checkpoint bootstrap only. Product Behaviours receive read-only NodeView/query capabilities, not NodeIndex,
NodeGraph, AuthorityPort, or RenderSystem. Generate catalog hashes from the canonical Scene/Prefab/Resource/Component and
authority-state manifest, and let the Client compare them before Scene installation. Built-in renderer state must be fully
validated before Node mutation and commit-gate seal.
