# Three RenderBackend 0.13.0

`@scene-engine/renderer-three@0.13.0` is the browser composition-root implementation of Display's flat RenderBackendPort. Its
root exports only:

```text
THREE_RENDER_BACKEND_SCHEMA
ThreeRenderBackendError
createThreeRenderBackend
```

The package also publishes `src/index.d.ts`.

## Boundary

The factory accepts DOM host, canvas, renderer profile, ResourceRegistry, lifecycle AbortSignal and a health observer. It returns
15 methods used by DisplayRuntime:

```text
createBinding / updateBinding / destroyBinding
prepareFrame / render / requestResize
pick / pickProximity / screenPointToWorldRay
projectWorldPoint / focusWorldPoint / capture
whenIdle / diagnostics / dispose
```

The backend owns Three/WebGL objects, model/texture/material loading, GPU resources, flat bindings, batching, resize, draw,
picking, capture and disposal. It does not own:

- product World or rules;
- Node names, parent graph or local Transform;
- Component lifecycle;
- application RAF;
- hidden cameras or lights;
- product callbacks or controls;
- caller-visible Three objects.

The backend schema is `scene-engine-three-render-backend@3`. Each `updateBinding` patch has exactly six fields:
`identity`, `worldMatrix`, `panelAnchorWorld`, `visible`, `batchable`, and `properties`. The anchor is a finite world-space vec3 or `null`;
only `render.sprite@3` may have a non-null anchor. `batchable` is a strict boolean port flag set by Display: `false` while the
Display AnimationSystem owns a transient override for the binding, `true` otherwise. It is not a public Sprite property.
The two pointer-query methods extend the port without changing the binding record or backend schema.

Display passes its NodeGraph-computed world matrix, the derived panel anchor, logical visibility and already normalized closed
component properties. Display must reject invalid business records before commit seal; the backend repeats defensive
shape/resource checks to protect its own boundary and asset-loading failures.

## Binding representation

Each RenderComponent owns one logical binding `(nodeName, componentKey)`. Logical visibility is independent of representation:

```text
ordinary object drawable = visible && !batched
batch instance drawable  = visible && batched
```

An ordinary object and its `InstancedMesh` instance are alternatives, never two visual parts. Batch creation hides the ordinary
object and removes that inactive representation, plus an empty per-Node root, from the active Three scene traversal; the
logical binding and its resource leases remain owned. A hidden instance uses a zero matrix. Leaving or disposing the batch
while the backend remains live restores the ordinary object according to logical visibility. Whole-backend disposal tears
down both representations directly and never reattaches inactive ordinary objects. Ordinary picking excludes batched
records, and instance hits map back to the same logical binding.

When several bindings are destroyed in one JavaScript turn, their now-empty per-Node roots lose logical ownership
immediately and are removed from the private Three scene by one queued microtask compaction; a batch rebuild or backend
disposal also performs the same bulk cleanup. This keeps idle/no-camera churn bounded and burst teardown linear without
leaving a drawable or pickable representation alive. Batch meshes are likewise detached from their shared parent in one
linear pass before their individual GPU resources are disposed.

Batch membership is rebuilt only when binding membership, eligibility, resources, or a batch fingerprint changes. A steady
frame writes only dirty instance records and marks their matrix and panel-anchor attribute ranges for partial GPU upload;
handles that declare procedural continuous drawing are the only handles sampled every frame. Mesh batch bounds expand
conservatively when a dirty visible instance moves, so frustum culling and picking cannot use a stale smaller sphere. A later
batch rebuild resets the bound and lets Three compute it exactly again.

### Fixed panel vertices

The fixed-facing Node world matrix is never changed in the backend. For perspective cameras, let `a` be the view-space
`panelAnchorWorld` and `v` the ordinary view-space vertex. When `a.z < -1e-6`, the sprite vertex shader applies:

```text
v.xy += a.xy * ((v.z - a.z) / a.z)
```

It then projects `v` normally. The anchor itself and vertex depth are unchanged. This removes the off-axis perspective shear
introduced by camera translation while retaining pitch foreshortening and normal distance scaling. A null anchor, an
orthographic camera or an anchor on/behind the near eye plane uses ordinary projection. There is no product-name branch,
automatic height expansion, camera-facing rotation, or depth-order override.

Ordinary sprites use an anchor uniform; sprite batches use a vec4 instance attribute with an enabled flag. CPU picking
intersects the same compensated quad, respects hidden instances, and returns its actual hit point. Bounds of the original
quad do not bound this deformation, so compensated objects and sprite batches bypass undeformed frustum culling. Backend
rebuild and asynchronous resource replacement restore the declarative anchor with the world matrix.

## Resources and time

Resource loads honor AbortSignal and generation tokens. Removing a pending binding prevents late attachment; destroy/recreate
for one identity is serialized. URL textures are decoded with one consistent vertical-orientation rule. Source model material
semantics remain unless closed component properties explicitly override them.
Bindings that share one lifecycle AbortSignal share one native abort listener; the backend fans cancellation out to their
private controllers and removes the listener after the last binding leaves or once when the backend is disposed. Registration
is therefore constant-time per binding while an actual shared cancellation remains linear in the number of bindings it must
cancel.

Material Resource properties are applied once when the resource is created. Mesh bindings clone that configured material;
ordinary meshes and instance batches retain the same tint and opacity without multiplying the descriptor a second time.
Each binding owns its clone, so updates, batch rebuilding and disposal do not alter the shared resource or other bindings.

The renderer never owns a playable timeline. Display's AnimationSystem samples each player against its own local
`visualSeconds` origin and delivers only final effective properties (`sprite.frame` today); the backend applies the value
without knowing where it came from. Global procedural effects such as water still sample `visualSeconds`; each procedural
particle emitter starts from its own first-sample visual origin. `sourceTick` is not sampled by any animation path, never
mutates World state, and exists on the frame contract for simulation alignment and diagnostics.
`TICKS_PER_SECOND` remains an internal variable equal to the fixed contract value 60.

Animated bindings are marked `batchable: false`: they never enter static `InstancedMesh` batches, and per-frame value flips
update only their own handle. Static batches rebuild at most once when a binding's batching eligibility changes; frame flips
never rebuild them. Model handles no longer create an animation mixer, Sprite handles no longer own a frame timeline, and
animation Resources are Display data that the renderer never loads.

`prepareFrame(frame)` consumes dirty bindings and the active camera; parameterless `render()` performs the requested draw from
that prepared state. Exact picking returns plain `{nodeName, componentKey, point, distance}` data or `null`;
project/focus/capture/diagnostics also return plain data only.

## Pointer queries

`pickProximity({clientX, clientY, radiusPixels})` accepts finite client coordinates and a finite CSS-pixel radius from `0` to
`256`. Radius `0` uses the existing exact-pick target semantics and returns that binding with `screenDistancePixels: 0` and the
hit point's normalized-device depth. It is therefore the exact-hit mode, not a special nonzero tolerance.

For a positive radius, the backend tests every current visible, pickable logical binding against the renderer-owned projected
screen bounds or pick proxy for its effective ordinary, batched or compensated representation. It measures the shortest CSS
pixel distance from the pointer to that proxy, rejects distances beyond the radius, then orders candidates by
`screenDistancePixels`, normalized-device `depth`, and stable `(nodeName, componentKey)` identity. The result is frozen plain
data or `null`:

```js
{ nodeName, componentKey, screenDistancePixels, depth }
```

This is a screen-space interaction tolerance. It is not a world-space radius, pen altitude, pressure, or distance to an
application-defined collider. Display owns ancestor target resolution and does not ask the renderer to interpret product
roles or metadata.

`screenPointToWorldRay({clientX, clientY})` uses the same host-element client-coordinate system and current active camera. It
supports perspective and orthographic cameras and returns frozen finite plain data with a normalized direction:

```js
{ origin: [x, y, z], direction: [x, y, z] }
```

Both queries require an active camera, reject unknown input fields and never expose a Three object. Invalid screen-point,
proximity, viewport and derived-ray records fail with bounded `three-backend-*` errors; a missing active camera remains
`three-active-camera-required`. A Display pointer controller performs at most one `pickProximity` and one
`screenPointToWorldRay` call for one accepted DOM event; the renderer does not schedule a second loop or retain gesture
history.

Backend health can trigger `DisplayRuntime.rebuildRenderBackend()`, which preserves Display Node/Component identity and remounts
bindings. Disposal aborts pending work and releases renderer, geometry, material, texture, binding and listener ownership.
