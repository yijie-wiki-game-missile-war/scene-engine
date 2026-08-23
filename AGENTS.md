# Agent Instructions

Before changing this repository, read `README.md` and the relevant current document in `docs/`.

`docs/runtime.md` is binding for simulation, scheduling, communication, recording, Replay, animation, and acceptance
work. The sole logical clock is an ordered integer tick at exactly 60 Hz. A tick commit always contains a complete scene
frame; a same-tick input commit may omit it only when the visual state did not change.

This directory is an independent repository. Keep product rules, product state schemas, network frameworks, HTTP, assets,
and visual factories outside it. Integrate through `EngineProgram`, transport, recorder, client observer, and renderer
factory ports.

There is one mutable world owner, one Engine packet stream, one client WorldState pointer, one scene tree, one cumulative
ACK cursor, and one packet-log format. Do not add aliases, decoder fallbacks, parallel cursors, secondary stores, or a
second scheduling clock.

Change protocol layouts and cross-language behavior together with Python tests, JavaScript tests, fixtures, package locks,
and current docs. Run `python3 scripts/verify_cutover.py` before handoff.
