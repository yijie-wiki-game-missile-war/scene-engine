# Display Node / Component contract

This document freezes the breaking Scene Engine 0.7 display contract. It is
the only current display model; there is no compatibility decoder, adapter,
alias, feature flag, or dual runtime.

## Release tuple

```text
scene-engine Python                 0.7.0
@scene-engine/client               0.7.0
@scene-engine/display              0.1.0
@scene-engine/renderer-three       0.9.0
wire                               scene-engine-wire@2
display                            scene-engine-display-node@2
packet log                         scene-engine-packet-log@2
```

The sole logical clock remains the ordered integer `source_tick` at exactly
60 Hz. Every progressed tick still produces and records one commit. The
breaking change is that each commit carries a complete ordered display command
stream, possibly empty, instead of a complete scene frame.

## Sole display model

One `DisplayRuntime` owns one active `Scene`, one `NodeIndex`, one `NodeGraph`,
one `ComponentScheduler`, and one `RenderSystem`. `Scene` references those
runtime services; it does not own duplicate instances.

`SceneDefinition` and `PrefabDefinition` are immutable Resources. A Prefab
instance is an ordinary Node subtree. Every Node has exactly one local TRS:

```js
{
  position: [x, y, z],
  rotationXyzw: [x, y, z, w],
  scale: [x, y, z],
}
```

The boundary copies finite numbers, normalizes nonzero quaternions, and rejects
zero or negative scale. Components do not contain a second transform. Anything
with an independent pose is represented by a child Node.

Canonical Node names are at most 192 UTF-8 bytes and use lowercase segments
matching `[a-z0-9][a-z0-9._-]*` under exactly one of these prefixes:

```text
sys/ scene/ py/ prefab/ editor/
```

Names are immutable. Python supplies complete `py/` names and never refers to
Prefab-local names. `null` authority parent means `sys/authority-root`; a
non-null authority parent must be another existing `py/` Node. Maximum Node
depth is 128.

## Authority and catalog boundary

Python owns the stable name, existence, parent, local transform, visibility,
logical `prefab_type`, and complete authority state of every `py/` Node. It
selects one `scene_name` and sends no URL, model, texture, material, light,
camera, pipeline, or Prefab-local structure.

Arts owns concrete Scene/Prefab/Resource definitions and pure synchronous state
resolvers. A checkpoint carries lowercase SHA-256 identities for the scene
catalog, Prefab catalog, and authority-state schema. A mismatch rejects the
session before the runtime becomes active.

The authority surface contains only single-target operations:

```text
createNode
setNodeTransform
setNodeParent
setNodeVisible
setNodeState
replaceNodePrefab
removeNode
```

`setNodeState` is complete state replacement, not merge patch. Each operation
validates before mutation and succeeds or fails independently. There is no
aggregate mutation call or public nodes-map mutation.

`replaceNodePrefab` stages an unregistered shadow scope, validates and attaches
it, then swaps the old and new scopes in one target operation. New and old
Prefab-local canonical names are never simultaneously registered in the sole
`NodeIndex`.

## Checkpoint and commit seal

A checkpoint contains:

```text
scene_name
scene_catalog_hash
prefab_catalog_hash
state_schema_hash
last_command_seq
parent-before-child authority Node baseline
```

The Client creates a fresh Display session through its configured session
factory, installs the SceneDefinition, creates each authority Node, activates
the Scene, and only then swaps its current session pointer. Failure disposes the
candidate and leaves the previous active session untouched.

A commit contains a strictly ordered `scene-engine-node-command@2` stream. The
Engine, not the product, assigns one stream-global `command_seq` to each record
and stamps the commit `source_tick`. Empty streams preserve the command cursor.

One complete Engine commit packet is also the display seal:

1. decode and validate the whole packet and all command records;
2. prepare the next immutable WorldState without publishing it;
3. close the DisplayRuntime draw gate;
4. synchronously apply each command through the AuthorityPort;
5. seal the gate with the packet cursor and source tick;
6. publish WorldState, display view, commit cursor, observer result, and ACK.

JavaScript run-to-completion plus the closed draw gate prevents RAF from
observing a partial commit. The seal does not create cross-command rollback.
If any command fails, the runtime becomes projection-invalid, scheduler/draw
stop, no ACK is emitted, and recovery requires a fresh checkpoint/session.

ACK remains cumulative and means WorldState, display commands, and cursor have
completed this synchronous barrier. It never waits for resource loading,
Component ticks, observer callbacks, or draw.

## Component lifecycle and scheduling

Only synchronous optional handlers exist:

```text
onAttach(context)
tick(frame)
onDispose(context, reason)
```

Only BehaviourComponents tick. The fixed phases and frame order are:

```text
update
NodeGraph world-transform flush
before-render
NodeGraph world-transform flush
RenderSystem.prepareFrame
RenderBackend.render
```

`DisplayRuntime` owns the sole application RAF. Attach order is Node preorder
then declaration order. Dispose is child-before-parent then reverse declaration
order. Promise-returning handlers fail. Attach failure rolls back the new
scope; tick failure makes the runtime unhealthy and stops scheduling; dispose
continues cleanup while collecting errors.

RenderComponents are closed declarative data. `RenderSystem` owns binding
registration, dirty propagation, async resource generations, required-resource
readiness, batching, active camera, and backend rebuild. One backend binding is
identified by `(nodeName, componentKey)`; a Node may therefore have multiple
RenderComponents without an aggregate binding ambiguity.

## Three backend

`ThreeRenderBackend` owns Three/WebGL objects, loaders, GPU resources, draw,
pick, project, capture, resize, and disposal. It does not own the application
NodeGraph, business Components, or an application RAF; it does not mirror
non-rendering Nodes and never returns raw Three values.

Renderer visual time is either `source_tick / 60` or an explicitly visual-only
clock. Simulation animations, Replay, seek, pause, and capture never derive
rule or simulation state from wall time.

## Product and Authoring parity

Live, Replay, acceptance scenes, Scene Editor, and Prefab Editor use the same
SceneDefinition, PrefabDefinition, registries, DisplayRuntime, RenderSystem,
and Three backend. Only their command source differs. Authoring helpers use
`editor/` Nodes, and saved definitions contain no `editor/` content.

`createDisplayRuntime({authoringMode:true})` exposes a restricted `localEdit`
port. It can edit `scene/`, non-authority `prefab/`, and owned `editor/` Nodes
through final Node/Component methods, and can instantiate formal Prefabs under
an `editor/` root. It rejects `sys/`, every `py/` Node, and every Prefab child
owned by Python. Production does not enable this port.

No previous tree cache, numeric display identity, aggregate composition,
alternate runtime, shared Arts engine package, or review fallback is part of
the current tuple.
