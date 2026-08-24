# Agent Instructions

Before changing this repository, read `README.md` and the relevant current document in `docs/`.

`docs/runtime.md` is binding for simulation, scheduling, communication, recording, Replay, animation, and acceptance
work. The sole logical clock is an ordered integer tick at exactly 60 Hz. A tick commit always contains a complete scene
frame; a same-tick input commit may omit it only when the visual state did not change.

This directory is an independent repository. Keep product rules, product state schemas, network frameworks, HTTP, assets,
and product visual composition outside it. Integrate through `EngineProgram`, transport, recorder, client observer, and
pure-data renderer ports.

There is one mutable world owner, one Engine packet stream, one client WorldState pointer, one scene tree, one cumulative
ACK cursor, and one packet-log format. Do not add aliases, decoder fallbacks, parallel cursors, secondary stores, or a
second scheduling clock.

Change protocol layouts and cross-language behavior together with Python tests, JavaScript tests, fixtures, package locks,
and current docs. Run `uv run python scripts/verify_cutover.py` (or an equivalent Python >=3.10 environment) before handoff.

Before changing `@scene-engine/renderer-three`, its adapters, display scheduling, health/rebuild behavior, resource
contracts, or renderer acceptance evidence, also read and follow `docs/render-runtime.md`. Renderer 0.8 accepts only the
V2 schemas and five `@2` pipelines documented there; do not add a legacy parser, alias, default light, RenderTarget claim,
product callback, or caller-visible Three object.
