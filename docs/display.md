# Display Node / Component contract

This document freezes the breaking Scene Engine JavaScript display contract. It is
the only current display model; there is no compatibility decoder, adapter,
alias, feature flag, or dual runtime.

## Release tuple

```text
scene-engine Python                 0.8.0
@scene-engine/client               0.9.0
@scene-engine/display              0.3.0
@scene-engine/renderer-three       0.9.2
wire                               scene-engine-wire@2
display                            scene-engine-display-node@3
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
sys/ scene/ py/ prefab/
```

Names are immutable. Python supplies complete `py/` names and never refers to
Prefab-local names. `null` authority parent means `sys/authority-root`; a
non-null authority parent must be another existing `py/` Node. Maximum Node
depth is 128.

## Authority and catalog boundary

Python owns the stable name, existence, parent, local transform, visibility,
exact `prefab_id`, and complete authority state of every `py/` Node. It
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
factory. A session contains exactly `runtime`, `authorityPort`, `commitGate`
and `dispose`. The candidate installs the SceneDefinition, creates each
authority Node parent-first, activates and starts the Scene, returns an O(1)
summary, and constructs the checkpoint ACK bytes before it replaces the current
session pointer. The ACK is returned only after that swap. Failure disposes the
candidate and leaves the previous active session untouched. A successful
replacement disposes the previous session.

A commit contains a strictly ordered `scene-engine-node-command@3` stream. The
Engine, not the product, assigns one stream-global `command_seq` to each record
and stamps the commit `source_tick`. Empty streams preserve the command cursor.

One complete Engine commit packet is also the display seal:

1. decode and validate the whole packet and all command records;
2. prepare the next immutable WorldState without publishing it;
3. close the DisplayRuntime draw gate;
4. synchronously apply each command through the AuthorityPort;
5. seal the gate with the packet cursor and source tick;
6. publish the WorldState and commit/command cursors;
7. read `runtime.summary()` in O(1) and encode the cumulative ACK;
8. queue the summary observer as a microtask and return the ACK bytes.

JavaScript run-to-completion plus the closed draw gate prevents RAF from
observing a partial commit. The seal does not create cross-command rollback.
If any command fails, the runtime becomes projection-invalid, scheduler/draw
stop, no ACK is emitted, and recovery requires a fresh checkpoint/session.

ACK remains cumulative and means WorldState, display commands, and cursor have
completed this synchronous barrier. It never waits for a full DisplayView,
resource loading, Component ticks, HUD, observer callbacks, RAF, or draw.
Observer scheduling and execution cannot roll back the installed state or
withhold its ACK.

## Summary and explicit snapshots

`DisplayRuntime.summary()` returns a new shallow-frozen record using this
schema:

```js
{
  schema: 'scene-engine-display-summary@1',
  sceneName: 'main',
  revision: 123,
  cursor: {
    commitSeq: 123,
    sourceTick: 121,
    lastCommandSeq: 992,
  },
  nodeCount: 1503,
  health: 'ready',
}
```

`DISPLAY_SUMMARY_SCHEMA` is exported by `@scene-engine/display@0.3.0`.
`nodeCount` reads `NodeIndex.size`; the other fields read the active Scene id,
runtime revision, cursor and health. Summary creation never iterates Nodes or
Components, captures the RenderSystem, clones resources, or invokes
`currentView()`. Its time and allocation size are independent of tree size.

`DisplayRuntime.currentView()` is the explicit immutable full-tree snapshot.
The Client exposes it through explicit `currentDisplayView()` and includes a
full view only when `capture()` is explicitly requested. It is suitable for
production picking/focus resolution, diagnostics and tests, but is never
materialized automatically for an `onCommit` observer. That observer receives
only `{kind, commit, worldState, displaySummary}`.

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

## Component property mutation

A Component exposes read-only `properties`, `enabled` and `node` state; it has
no public property mutation operation. The sole property update boundary is:

```js
componentRegistry.patchComponentProperties({
  component,
  patch,
  resourceRegistry,
})
```

The registry identifies the registered descriptor, merges the current value
and patch, normalizes the complete candidate, derives all resource references,
and requires every Resource id and kind from ResourceRegistry. Only a fully
valid candidate crosses the package-private mutation boundary and notifies the
Component context. Failure is atomic: the old properties identity, render
dirty state, resource leases and draw request remain unchanged. Prefab state,
authority state and replacement paths all use this same registry boundary.

## Disposal

Runtime disposal stops its RAF, closes the commit gate, aborts lifecycle work,
unloads every Scene and Prefab scope, disposes RenderSystem resources, clears
the Component scheduler and empties NodeIndex before releasing the Scene.
SceneLoader's scope array is empty and its active Camera is cleared;
PrefabInstantiator's scope map is empty and its Scene/context references are
disconnected; Scene clears its roots, definition, compiled definition, loader
and active Camera references. Pending resource work cannot mount late. Cleanup
continues while collecting errors, and repeated `dispose()` calls return the
same operation.

## Three backend

`ThreeRenderBackend` owns Three/WebGL objects, loaders, GPU resources, draw,
pick, project, capture, resize, and disposal. It does not own the application
NodeGraph, business Components, or an application RAF; it does not mirror
non-rendering Nodes and never returns raw Three values.

Logical visibility and representation are separate for every binding:

```text
ordinary object drawable = visible && !batched
batch instance drawable  = visible && batched
```

Building a batch hides the retained ordinary object. Transform, visibility,
property and resource-replacement updates preserve that hidden state. A hidden
batch member uses a zero matrix; leaving or disposing the batch restores the
ordinary object according to logical visibility. Picking excludes the ordinary
object while batched and returns at most one hit for a logical binding. Batch
state is private to the Three backend and never appears in Display Core.

Renderer visual time is either `source_tick / 60` or an explicitly visual-only
clock. Simulation animations, Replay, seek, pause, and capture never derive
rule or simulation state from wall time.

## Browser product surfaces

The browser has two current surfaces: production Live/Replay and a read-only
Arts Showcase. Production receives Python checkpoint/commands through the
Client and retains explicit business picking and focus. Focus updates the
Camera Node's single local Transform, including both position and look-at
quaternion; it never mutates a raw Three Camera as a second authority.

Showcase creates a fresh DisplayRuntime and Three backend over the same formal
Scene, Prefab, Resource and Component registries. It does not create a Client,
WebSocket, WorldState, ACK flow or authority-node fixture. Fixed catalog
entries, Camera presets and UI kits provide orbit, pan, zoom, reset, fullscreen
and capture without Node picking, selection, mutation, save or export. Arts
owns the Showcase catalog and UI details; Display Core has no separate mode or
runtime API for it.

No previous tree cache, numeric display identity, aggregate composition,
alternate runtime, shared Arts engine package, or review fallback is part of
the current tuple.
