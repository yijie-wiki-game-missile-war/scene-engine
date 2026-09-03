# Pointer interaction contract

Status: implemented by `@scene-engine/display@0.16.0` and `@scene-engine/renderer-three@0.13.0`.

## Confirmed scope

Display will normalize browser Pointer Events into these nine application-facing completion or observation events:

| Event | Meaning |
| --- | --- |
| `click` | A claimed primary-button sequence completes on the same selectable target without becoming a drag. |
| `context-click` | A claimed secondary-button sequence completes on the same selectable target. |
| `double-click` | The second of two matching completed `click` events meets the configured time and distance limits. |
| `drag-grab` | A claimed primary sequence first crosses the drag threshold on a drag source. |
| `drag-move` | An already grabbed pointer moves. |
| `drag-drop` | A grabbed pointer is normally released, including over empty space. |
| `proximity-enter` | An idle mouse or hovering pen enters one configured screen-space target radius. |
| `proximity-move` | An eligible pointer remains near the same target. |
| `proximity-leave` | The active proximity interval ends or changes target. |

The spelling of the drag lifecycle is strict: `drag-grab`, `drag-move`, and `drag-drop`. `press` is a lower-level optional
notification after a claim succeeds; `cancel` and `onError` are lifecycle and failure notifications, not additional completed
gestures.

The capability is generic. Applications decide what a target means, whether to claim it, whether a drop is valid and what local
preview to show. Display never moves an Authority Node or interprets gameplay metadata.

The implementation surface is:

```text
@scene-engine/display              0.16.0
@scene-engine/renderer-three       0.13.0
scene-engine                       0.19.0
```

`@scene-engine/client@0.16.0`, `scene-engine-wire@3`, `scene-engine-display-node@9`, catalog/Prefab schemas, packet-log and
Replay formats remain unchanged. Pointer event time is used only for local recognition. It never advances or rewrites the
authoritative integer 60 Hz tick, enters a checkpoint or commit, changes ACK meaning, or creates a Replay record. For an
authority-owned target, Display produces one common `{nodeId, eventName, payload}` record. A configured `sendInput` forwards
that record through the existing `engine.input` path; Python decodes and dispatches it by the same numeric Node ID and event
name. No second transport or message kind exists.

## Ownership boundary

| Concern | Owner |
| --- | --- |
| DOM listeners, one-pointer state machine, thresholds, claiming, capture, context-menu suppression and callbacks | Display pointer controller |
| Pointer-target declaration, nearest-enabled-ancestor resolution and frozen product metadata | Display |
| Exact picking, screen-space pick proxies, active-camera projection and world-ray calculation | RenderBackend implementation |
| Per-authority-Node listener registration and optional existing-input forwarding | application composition |
| Gesture eligibility, local preview, drop validation and camera policy | application |
| Gameplay validation and mutation | product runtime |

Only the browser composition root imports the Three backend. The renderer receives no product callback or pointer-target data;
Display exposes no Three object, renderer binding or mutable Node through an interaction sample. Callbacks run outside the
checkpoint/commit barrier and cannot delay or withhold an ACK.

## Pointer target component

Display adds one built-in, non-rendering Component:

```js
{
  key: 'pointer',
  type: 'interaction.pointer-target@1',
  properties: {
    roles: ['proximity', 'select', 'drag-source', 'drop-target'],
    data: { productId: 'unit-7' },
  },
}
```

The public class is `PointerTargetComponent`; its `typeId` is `interaction.pointer-target@1` and `allowMultiple` is false. Its
closed properties are exactly `{roles, data}`:

- `roles` is a required non-empty, duplicate-free array whose declaration order is retained. Every value is one of
  `proximity`, `select`, `drag-source`, `drop-surface`, or `drop-target`.
- `data` is a required strict JSON plain object. Display clones and deeply freezes it; only the application interprets it.
- `select` permits primary click/double-click and secondary context-click recognition. `drag-source` permits a primary drag.
  `proximity` opts into proximity. `drop-surface` and `drop-target` are advisory roles inspected by the application at move or
  drop time.

After a renderer binding is selected, Display walks from its Node toward its parents and resolves the nearest enabled
`PointerTargetComponent`. Lookup is proportional to Node depth and never constructs a complete `DisplayView`. A disabled or
removed Component is not eligible. Nested Prefab Nodes participate through the same single NodeGraph.

## Renderer and Display queries

The RenderBackendPort adds two plain-data methods while retaining the existing exact `pick` method:

```js
pickProximity({ clientX, clientY, radiusPixels })
screenPointToWorldRay({ clientX, clientY })
```

`radiusPixels` is finite, measured in CSS pixels and limited to `0..256`. A zero radius delegates to exact pick semantics and
returns distance zero for an exact hit. A positive radius uses renderer-owned projected screen bounds or a pick proxy for the
effective visible and pickable representation. This is required for ordinary objects, batches and compensated sprites: only
the renderer knows their actual pick representation. It is not ordinary exact hover, a world-space radius, pen altitude,
pressure, or distance to arbitrary gameplay geometry.

The Three backend returns the nearest frozen plain binding record:

```js
{ nodeName, componentKey, screenDistancePixels, depth }
```

Candidates outside the radius are rejected. Remaining candidates are ordered by screen distance, normalized-device depth and
stable `(nodeName, componentKey)` identity. An active camera is required. Perspective and orthographic cameras both support
the world-ray query, which returns finite plain vectors with normalized direction:

```js
{ origin: [x, y, z], direction: [x, y, z] }
```

DisplayRuntime exposes renderer-neutral queries:

```js
runtime.pickInteraction({ clientX, clientY })
runtime.pickInteractionProximity({ clientX, clientY, radiusPixels })
runtime.screenPointToWorldRay({ clientX, clientY })
```

The first query starts from exact `pick`; the second starts from `pickProximity`. Their frozen result is `null` when no renderer
binding is selected, otherwise it is:

```js
{
  hit: { nodeName, componentKey, point, distance }, // exact query
  // or { nodeName, componentKey, screenDistancePixels, depth } for proximity
  target: {
    nodeName,
    authorityOwnerName,
    authorityNodeId,
    roles,
    data,
  } // or null
}
```

A selected binding without an eligible pointer target remains distinguishable from empty space through `target: null`. The
controller uses exact interaction queries for press, click and drag, and the radius query only for idle proximity.

## Controller API

Display exports one controller factory. Defaults are part of the contract:

```js
const nodeEventHub = new PointerNodeEventHub();
const controller = createPointerInteractionController({
  element,
  runtime: () => currentDisplayRuntime,
  nodeEventHub,

  primaryButton: 0,
  secondaryButton: 2,
  dragThresholdPixels: 4,
  doubleClickIntervalMs: 350,
  doubleClickDistancePixels: 6,
  proximityRadiusPixels: 12,

  claim(sample) {
    return tokenOrNull;
  },

  onPress(token, sample) {},
  onClick(token, sample) {},
  onContextClick(token, sample) {},
  onDoubleClick(token, sample) {},
  onDragGrab(token, sample) {},
  onDragMove(token, sample) {},
  onDragDrop(token, sample) {},
  onProximityEnter(sample) {},
  onProximityMove(sample) {},
  onProximityLeave(sample) {},
  onNodeEvent(event) {},
  sendInput(input) {},
  onCancel(token, sample) {},
  onError(error) {},
});

controller.dispose();
```

Buttons are distinct Pointer Events button numbers. Pixel thresholds are non-negative finite CSS-pixel values;
`proximityRadiusPixels` also obeys the renderer's `0..256` bound. The double-click interval is a positive finite millisecond
value. Configuration is fixed for a controller lifetime.

`runtime()` supplies the current Display session without transferring ownership. `claim(sample)` is synchronous and returns an
opaque application token or `null`. Display calls it only for an eligible exact-hit sequence: a primary target has `select` or
`drag-source`, while a secondary target has `select`. A null result leaves the whole sequence untouched for camera or other
application controls. A non-null result establishes controller ownership; only then does the optional `onPress` run.

Every callback sample is deeply frozen plain data:

```text
phase / optional bounded reason
pointerId / pointerType / button / buttons
clientX / clientY
startClientX / startClientY
deltaClientX / deltaClientY
startInteraction / currentInteraction
worldRay
```

Coordinates and deltas are CSS pixels. `startInteraction` is the exact press result for gestures and the first radius result
for a proximity interval. `currentInteraction` is the current event's result and may be `null`, including a drag-drop over
empty space. `worldRay` belongs to the current accepted Pointer Event. Samples contain no DOM Event, live Component, mutable
Node, backend binding or renderer object.

## Authority Node listeners and Python input

The nine completion/observation phases, but not `press` or `cancel`, also produce one `PointerNodeEvent` when the selected
target belongs to a Python authority root:

```js
{
  nodeId: 7,
  eventName: 'click',
  payload: sample,
}
```

`nodeId` is the same stream-stable numeric ID used by Python `DisplayNode` and Display `py/<id>`. A Scene-local target has
`authorityNodeId: null`, has no Python counterpart and therefore stays on the phase callbacks. Drag lifecycle events remain
addressed to the grabbed source Node; the payload's `currentInteraction` can name a different drop target. Proximity leave
remains addressed to the Node whose interval is ending.

`PointerNodeEventHub.addEventListener(nodeId, eventName, listener)` provides synchronous Display-side per-Node delivery. Passing
the hub as `nodeEventHub` makes the controller dispatch directly to it; `onNodeEvent` may additionally observe the same frozen
record. If `sendInput` is supplied, the controller also calls it with the canonical descriptor returned by
`pointerNodeEventInput(event)`:

```js
{
  command: 'display.pointer-event',
  args: { node_id: 7, event_name: 'click', payload: sample },
}
```

The composition root can pass its existing connection's `sendInput` method directly; the controller does not own a socket or
an input ID allocator. In Python, `PointerNodeEvent.from_engine_input(request)` decodes that command and
`PointerNodeEventHub.dispatch_engine_input(request)` performs the same synchronous `(node_id, event_name)` lookup from inside
`EngineProgram.handle_input`. The product still returns the transaction's `MutationResult` and remains responsible for all
gameplay validation. Listener exceptions follow the surrounding callback/input failure boundary, and Promise/awaitable
listeners fail because delivery is synchronous on both ends.

The Python program owns its hub and invokes it at its existing input boundary:

```python
pointer_events = PointerNodeEventHub()
pointer_events.add_event_listener(node_id, "click", on_click)

def handle_input(world, request, context):
    event = pointer_events.dispatch_engine_input(request)
    if event is not None:
        return MutationResult.no_op(reason_code="pointer-observed")
    # Continue with the product's other input commands.
```

The first version owns at most one active pointer. Other pointer IDs are ignored until it completes or cancels.

## Recognition state machine

```text
idle or proximity
  | eligible pointerdown + exact query/ray + successful claim
  v
claimed primary candidate ---------------- claimed secondary candidate
  | release within threshold                 | release within threshold
  | same selectable target                   | same selectable target
  v                                          v
click [then possible double-click]           context-click
  |
  | first threshold crossing on drag-source
  v
drag-grab -- later pointermove --> drag-move -- normal pointerup --> drag-drop

any claimed state -- cancellation boundary --> cancel
```

### Click and double-click

A primary release completes `click` only when the start target has `select`, no movement has crossed the drag threshold, and
the release resolves to the same pointer-target Component. A target with only `drag-source` cancels on a short release rather
than inventing a click. A target with only `select` cancels once the threshold is crossed rather than inventing a drag.

The controller retains only the previous successful click candidate. The next successful click also emits `double-click` when
target Component identity, primary button and `pointerType` match and both the elapsed event time and CSS-pixel distance fit
`doubleClickIntervalMs` and `doubleClickDistancePixels`. Each ordinary click is delivered immediately: the second click callback
runs first, then double-click, and the pairing candidate is cleared. A drag, cancellation, incompatible click or lifecycle
reset cannot reuse stale history. This local browser timestamp never becomes authoritative time.

### Context click and native menu

Only the configured secondary button can complete `context-click`, and its start target must have `select`. A successful claim
owns that pointer sequence, captures it and suppresses the matching native menu. The controller prevents the active claimed
secondary Pointer Events and the first corresponding `contextmenu`; it does not derive a callback or perform another renderer
query from `contextmenu` itself. An unclaimed secondary sequence, keyboard context menu, or unrelated later context menu is
never prevented.

### Drag

Only a claimed primary sequence whose start target has `drag-source` may become a drag. Its first movement across
`dragThresholdPixels` emits exactly one `drag-grab`; later accepted moves emit `drag-move`. A normal release after grab emits
exactly one `drag-drop`. Grab and drop remain distinct even if there are no intervening move callbacks.

Every drag move and drop performs one exact interaction query. Display does not filter the result by a drop role: the
application inspects `currentInteraction.target.roles` for `drop-target` or `drop-surface` and decides validity. Empty-space
drop remains a real `drag-drop` with `currentInteraction: null`. `pointercancel` and all other abnormal endings emit `cancel`,
never a fabricated drop.

### Proximity

While no gesture is active, a `pointermove` from a mouse or a hovering pen with `buttons === 0` performs one
`pickInteractionProximity` using `proximityRadiusPixels` and one world-ray query. Touch never synthesizes proximity. A pen in
contact and every pointer during a claimed sequence are ineligible.

- no current interval plus a resolved target with `proximity` emits `proximity-enter`;
- the same pointer-target Component emits `proximity-move`;
- a different target emits leave for the old interval before enter for the new one;
- empty space, a binding with no pointer target or a target without `proximity` leaves the old interval;
- DOM `pointerleave` leaves without another renderer query.

The configured radius applies to the renderer binding's screen proxy before Display resolves the target ancestor. Radius zero
therefore means exact renderer hit; a positive value is a near miss measured in CSS pixels. Target identity is Component
identity, not equal `data`. Replacing the Component is leave followed by a possible later enter even if its properties are
equal.

Proximity is observational: it has no token, never captures, never calls `preventDefault` and never stops propagation.
Transitioning from proximity into an eligible pointerdown leaves first, then calls `claim` with the press sample. Ending a
gesture does not synthesize proximity from stale data; a later eligible move may enter again.

## Claiming and camera arbitration

The controller listens in the element's capture phase. After a successful claim it calls pointer capture when available and
prevents and immediately stops propagation for that pointer sequence. This reserves the sequence from a camera controller.
The controller releases capture at normal completion, cancellation and disposal.

An ineligible or unclaimed sequence is not captured, prevented or stopped, so camera orbit, pan and another application
handler can consume it. Proximity likewise remains fully observational. This is a small synchronous ownership boundary, not a
general gesture arena; Display does not decide application camera policy.

## Lifecycle and failures

The following boundaries end an active claimed sequence with exactly one `cancel`: DOM `pointercancel`, unexpected lost
capture, source Component removal or disable, removal of its required role, runtime/session replacement, renderer-backend
rebuild, Display disposal, explicit controller disposal and a query or callback failure. None emits `drag-drop`.

The same boundaries end an active proximity interval with exactly one `proximity-leave`. Runtime replacement clears the old
interval without querying the replacement; only the next eligible event may enter. Target and runtime validity are checked
before every later callback so a removed target cannot receive move, click or drop. Repeated lifecycle notifications and
repeated `dispose()` are idempotent. Disposal removes every listener, releases capture and clears the bounded double-click
candidate.

Constructor/configuration errors fail synchronously. Runtime query failures and callback exceptions clear the affected local
state and are reported to `onError`. A gesture callback error also cancels its claimed token once; a proximity callback error
leaves and clears that interval. These local failures neither mutate product World nor invalidate an otherwise legal Display
commit, and they cannot affect ACK. `onError` is the terminal observer for that local error and must not create a recursive
error loop.

## Performance contract

- One accepted Pointer Event performs at most one interaction query and one world-ray query. A transition such as proximity to
  press reuses that event's single result; separate hover and drag controllers may not duplicate the work.
- `contextmenu`, `pointerleave` and lifecycle-only cleanup perform no renderer query.
- Interaction resolution walks one parent chain and never constructs `currentView()` or traverses the whole NodeGraph.
- Pointer input schedules no RAF, advances no animation and mutates no Node.
- Retained state is bounded to one active pointer/token/start sample, one proximity interval and one double-click candidate.
  No gesture, hit, event or pointer history grows without bound.

The Three implementation may initially scan current pickable bindings to evaluate their renderer-owned proxies, but it must
not create duplicate logical representations or leak Three values. Its stable ordering keeps equal-distance results
deterministic and permits a later spatial index without changing the public contract.

## Implementation sequence

1. Add and register `PointerTargetComponent`, interaction target lookup, public types and exact/radius DisplayRuntime queries.
2. Add `pickProximity` and `screenPointToWorldRay` to RenderBackendPort, fake backends and Three; cover ordinary, batched,
   compensated, perspective and orthographic representations.
3. Implement the single-pointer controller, fixed event names, parameters, claiming, capture, native-menu policy and bounded
   state machine.
4. Connect Component, session, backend-rebuild and disposal lifecycle invalidation without entering commit/ACK logic.
5. Add the common authority-Node event record, Display/Python listener hubs and the adapter for the existing input command.
6. Publish `@scene-engine/display@0.16.0` and `@scene-engine/renderer-three@0.13.0`; keep Client, Wire and all data schemas
   unchanged.
7. Run the focused tests, strict TypeScript interop, package public-surface tests and the full Python/JavaScript gates.

Expected implementation areas are:

```text
js/packages/display/src/interaction/
js/packages/display/src/runtime/display-runtime.js
js/packages/display/src/render/render-system.js
js/packages/display/src/render/render-backend-port.js
js/packages/display/src/component/component-registry.js
js/packages/display/src/index.js
js/packages/display/src/index.d.ts

js/packages/renderer-three/src/backend.js
js/packages/renderer-three/src/validation.js
js/packages/renderer-three/src/index.d.ts
```

## Test and acceptance plan

Display tests must cover:

- exact `PointerTargetComponent` property validation, deep freezing, built-in registration and catalog identity;
- nearest enabled ancestor resolution through ordinary and nested Prefab Nodes without `currentView()` construction;
- public exact/radius interaction result validation and renderer error isolation;
- primary/secondary button filtering, default and custom thresholds, same-target release and ignored extra pointers;
- immediate click delivery, double-click time/distance/target/button/pointer-type matching and bounded history reset;
- claimed context-click suppression versus complete native-menu and camera pass-through when unclaimed;
- strict drag-grab/move/drop order, short-release role cases, empty-space drop and no drop on cancellation;
- proximity enter/move/leave, target changes, radius zero, positive radius, mouse, hovering pen, pen contact and no touch
  synthesis;
- proximity-to-claim ordering, no proximity callbacks during a claim and no stale re-entry after completion;
- source/target role changes, disable/removal, session replacement, backend rebuild, lost capture and idempotent disposal;
- callback/query failures, exact-once cancel/leave, listener/capture cleanup and no commit/ACK effects;
- all nine Node events use the same authority Node ID in Display and the canonical Python input, with synchronous scoped
  listeners on both ends;
- at most one interaction query and one world-ray query for every accepted DOM event.

Three backend tests must cover:

- strict coordinates and `0..256` radius validation, active-camera failures and frozen plain return data;
- zero-radius equality with exact picking;
- positive-radius CSS-pixel bounds for ordinary and batched bindings, compensated sprites and host-element offsets;
- visibility, pickability, clipping, resize and deterministic distance/depth/identity ordering;
- perspective and orthographic center/edge world rays with finite normalized output;
- no Three object leakage and unchanged existing exact pick, project, focus, capture and lifecycle behavior.

Integration tests must combine a real DisplayRuntime and Three backend with a nested pointer target, camera controls, positive
proximity radius, click/double/context recognition, proximity-to-drag transition, drop target, backend rebuild and final
disposal.
