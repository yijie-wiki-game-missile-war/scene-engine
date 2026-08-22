# Agent Instructions

Read `../AGENTS.md` and `../README.md` before working in this project.

This directory is an independent project repository. Run Git commands from
this directory and keep Scene Engine-specific code, tests, and documentation here.

The current Missile War v5 producer, transport, raw tape, Replay, and Arts
consumer remain governed by `../.engineer/contracts/mw-global-time-rule.md`.
Nothing in this project may silently replace or weaken that current 60 Hz
chain.

The Python package name is `scene_engine`. Keep gameplay rules and
Missile-War-specific state outside the package; integrate them through ports.
