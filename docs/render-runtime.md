# Three RenderBackend 0.18.0

`@scene-engine/renderer-three@0.18.0` is the browser composition-root implementation of Display's flat RenderBackendPort. Its
root exports only:

```text
THREE_RENDER_BACKEND_SCHEMA
ThreeRenderBackendError
createThreeRenderBackend
```

The package also publishes `src/index.d.ts`.

## Boundary

The factory accepts DOM host, canvas, renderer profile, an explicit composition plan or `null`, ResourceRegistry, lifecycle
AbortSignal and a health observer. It returns
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

The backend schema is `scene-engine-three-render-backend@4`. Each `updateBinding` patch has exactly seven fields:
`identity`, `worldMatrix`, `panelAnchorWorld`, `visible`, `batchable`, `compositionGroup`, and `properties`. The group is a
validated catalog-local ID for drawable bindings when a plan is active and `null` for ordinary single-pass rendering and
non-drawable bindings. The anchor is a finite world-space vec3 or `null`;
only `render.sprite@3` may have a non-null anchor. `batchable` is a strict boolean port flag set by Display: `false` while the
Display AnimationSystem owns a transient override for the binding, `true` otherwise. It is not a public Sprite property.
The two pointer-query methods extend the port without changing the binding record or backend schema.

Display passes its NodeGraph-computed world matrix, the derived panel anchor, logical visibility and already normalized closed
component properties. Display must reject invalid business records before commit seal; the backend repeats defensive
shape/resource checks to protect its own boundary and asset-loading failures.

## Upper-field projection terminal

Camera properties optionally declare a closed `projectionProfile`:
`{ mode: 'upper-field', startNdcY, strength }`. Omitted/null is identity; explicit strength zero is also identity.
Display validates finite `-1 < startNdcY < 1`, `strength >= 0`, and the complete-viewport inverse margin
`1-strength*(1-startNdcY) >= 0.01` before exposing a camera candidate. Orthographic cameras accept the same explicit profile.
No target-horizon mode is accepted on a camera. The Display root helper
`deriveUpperFieldProjection({pitchDegrees,fovYDegrees,startNdcY,targetNdcY})` produces an explicit profile for a symmetric
perspective camera with zero roll; the caller must pass the actual downward pitch/FOV and rerun it if maintaining the target
horizon after camera changes is desired. Explicit profiles retain their strength when FOV changes.

The single CPU source is Display's `projectUpperFieldY` and `unprojectUpperFieldY`. Above start `s`,
`F(y)=s+(y-s)/(1+k*(y-s))`; below start it is identity. Its inverse upper branch is
`G(q)=s+(q-s)/(1-k*(q-s))`. A pointer beyond the inverse domain fails with `display-projection-domain`; no denominator clamp
fabricates a ray.

The backend renders the same Scene and same active camera into a managed linear half-float color/depth target. During that
world draw it temporarily expands only the camera's vertical linear frustum to the original-NDC interval `[-1,G(1)]`.
Near/far, homogeneous depth, native triangle clipping and perspective-correct interpolation remain ordinary, so a huge
triangle or a near/eye-plane crossing does not rely on nonlinear interpolation of three warped vertices. Native frustum
culling sees the expanded viewport, including world geometry above the original upper plane. Main-camera color and selective
depth passes share that source image; genuine light-space shadow maps use their ordinary light cameras. The final fullscreen
triangle, in the same Scene and with the same camera, samples the source at G. It runs no world draw, shadow update or time
sample. Camera matrices, layers, root visibility, background, target and renderer/shadow flags restore in `finally`.

This terminal applies uniformly to imported GLB materials, overrides, mesh and sprite batches, existing fixed-panel
compensation, surfaces, particles and program materials. Existing material shaders do not install independent F hooks.
Programs reconstruct rays using the expanded camera inverse, exactly once. The optional program screen-UV input maps source
fragments back through F to the final viewport; it does not apply another geometric warp. Sprites explicitly choose full
geometry (the default) or the anchor/extent contract below; the latter prepares source coverage and UV for the same terminal.

Source resolution is explicitly one texel per CSS pixel before compression, independent of output DPR:
`ceil(cssWidth) × ceil(cssHeight*(G(1)+1)/2)`. Since `0<F'<=1`, a source texel's maximum center-to-corner displacement after
projection is at most `sqrt(2)/2 CSS px`; this sampling bound is separate from measured final raster edge error. This policy
can soften DPR2 content compared with a native-resolution source. It does not promise antialias-free tiny features or a
performance target. The source is limited to 16,777,216 pixels and the device's `maxTextureSize`, requires
`EXT_color_buffer_float`, and fails explicitly with `three-upper-field-budget-exceeded` or
`three-upper-field-device-unsupported` before allocating an unsupported source. No smaller-buffer or standard-projection
fallback occurs. Color remains linear HDR until the final tone mapping/color conversion. Diagnostics expose
`renderTargetCount` and `upperFieldSampling`; resize replaces the owned target, an identity render releases it, and dispose
releases target, triangle and material.

The existing output destinations have different transparency compositing spaces: identity renders directly to the sRGB
canvas, while upper-field composites in the linear intermediate target before final encoding. Overlapping blended objects
can therefore differ in brightness when switching profiles. Program sprites preserve the existing mesh/material behavior
within each profile; this release does not change the global blend/output pipeline or promise pixel equality across profiles.

CPU pick/ray first applies G. Proximity transforms the actual representation's projected bounds through F; radius zero
retains exact pick. `projectWorldPoint` returns finite coordinates only for a finite point within the camera depth interval.
Invalid near/behind/far points return `{clientX:null,clientY:null,depth:null,visible:false}`. Finite offscreen points retain
finite coordinates with `visible:false`; visible means inside final x/y viewport and near/far, without an occlusion promise.
Perspective focus suggestions fit a sphere with a 5% final viewport margin using inverse top/bottom limits and horizontal
FOV. An orthographic sphere that cannot fit the unchanged camera size, or any suggestion exceeding near/far, fails with
`three-focus-bounds-unfit`; the backend does not silently change zoom or camera position.
The alternative closed query `{position, halfExtents: [x,y,z]}` fits an axis-aligned world box by evaluating all eight
corners against inverse final viewport limits. Extents are finite and nonnegative; `radius` and `halfExtents` are mutually
exclusive. Box fit may move closer and fits the supplied bounds to the full viewport; callers wanting a margin provide
padded extents. It preserves the current view direction and camera projection and fails if the unchanged orthographic
size or near/far interval cannot contain the box.

Public capture includes `projection` source layout and byte estimates, aggregate `renderer` draw/program/geometry/texture
counters covering the whole composed frame, and `renderCpuSubmit` last-120-frame p50/p95/max submission durations.
Submission durations measure CPU work only, not GPU completion or frame latency.

The generic browser fixture `benchmark_display_browser.mjs --fixture=upper-field [--dpr=2]` exercises real WebGL raster edges
of a giant triangle across the compression join and upper screen, near/eye crossing, CPU hit/project agreement, device errors
and disposal. `--viewport=1920x1080`, `--dpr=2` and `--projection=orthographic` exercise viewport/DPR/projection variants;
the fixture also checks selective-depth occlusion and an actual directional shadow. Node tests cover profile domains, expanded-frustum depth, matrix restoration on failure, identity resource
release, and perspective/orthographic CPU queries. Broader Far Sea acceptance remains governed by its requirements matrix;
these fixtures alone do not establish all material/alpha/shadow performance combinations.

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

Batch membership is rebuilt only when binding membership, composition group, eligibility, resources, or a batch fingerprint
changes. A steady
frame writes only dirty instance records and marks their matrix and panel-anchor attribute ranges for partial GPU upload;
handles that declare procedural continuous drawing are the only handles sampled every frame. A hidden binding is not sampled
and does not keep requested-mode RAF alive. A continuous handle may additionally expose a renderer-private dynamic activity
predicate; particle emitters use it to idle at zero intensity, clear any previously drawn points and resume automatically when
their intensity becomes positive. Particle seed sampling avalanches the complete 32-bit input before conversion to a unit
value, so adjacent small seeds remain deterministic without collapsing multi-axis spread into a correlated line. Mesh batch bounds expand
conservatively when a dirty visible instance moves, so frustum culling and picking cannot use a stale smaller sphere. A later
batch rebuild resets the bound and lets Three compute it exactly again.

Opaque/masked `material.program` meshes with depth reads/writes enabled participate in these same representation,
visibility, depth and picking rules. Mutable typed parameters are stored in private
per-instance texture rows and update only dirty rows; they do not alter the static
batch fingerprint or trigger shader compilation. Immutable values, material Resource
identity and presentation flags remain in the fingerprint. Blended programs and
programs with depth reads or writes disabled stay ordinary to preserve ordering
against external drawables, keeping their declared depth flags unchanged. The full
contract and instance-data lifetime are in [Procedural programs](procedural-programs.md#program-mesh-batching).

## Selective depth composition

`scene-engine-render-composition@1` has exactly three ordered pass kinds: `protected-base`, `ordinary` and `foreground`.
Catalog-local groups partition across those passes and one declared group is the default. The backend maps at most 30 groups to
private Three layers; camera, light and shadow visibility use reserved masks and no caller-visible Three object is exposed.

One logical frame remains one `RenderBackend.render()` call and one Display RAF. With a plan, that call performs:

```text
clear and draw protected-base color/depth
draw ordinary against the resulting depth
clear working depth and redraw protected-base with colorWrite=false
draw foreground against the restored protected depth
```

The protected redraw uses the same objects, matrices, vertex shaders, alpha tests and depth-write settings as the color pass;
material color masks, camera layers, background, shadow update state and renderer clear state are restored in `finally`.
An alpha-blended protected material that intentionally has `depthWrite=false` does not become an occluder. No duplicate Scene,
Node tree, RAF or product-specific post-process is introduced. Upper-field projection adds one backend-owned offscreen color/depth target after the same composition logic. Capture reads the final composed canvas.

Ordinary objects cannot hide foreground objects, while protected geometry can hide both. Normal geometric depth and stable
identity ordering remain inside a pass. Exact picking collects the active ordinary or batched hits, rejects non-protected hits
behind the nearest protected hit, then chooses the highest visible pass before geometric depth. Positive-radius proximity first
returns that exact composed hit when the pointer covers one; otherwise its existing screen-proxy distance remains primary, with
composition rank preceding depth for equal-distance candidates and protected proxy depth rejecting covered candidates.

### Sprite projection semantics

`render.sprite@3` accepts optional `projectionSemantics: 'geometry' | 'anchor-extent'`. Omission preserves existing geometry
properties/serialization. Geometry mode uses the full transformed quad, including supported fixed-panel compensation, before
the common F projection. `anchorOffset` and `pivot` are rejected in geometry mode.
The resource branch is either the existing `textureResourceId`, or `materialResourceId` referencing a surface-stage
`material.program`; the program branch requires explicit anchor-extent and remains ordinary. Both use the same
coverage and queries. See [program sprites](procedural-programs.md#program-sprites).

Anchor-extent mode accepts `anchorOffset: [x,y,z]` (default `[0,0,0]`), the billboard center in Node local units before the
sprite width/height transform. Node world transformation determines the world anchor. Width and height are world/view-space
units multiplied by the lengths of the Node's world x/y basis columns; billboard axes align with camera view x/y. Node rotation
does not rotate the expanded image; negative scale uses its magnitude and does not mirror UV. Perspective projected size scales
with the anchor's clip w (view depth); orthographic size scales with the unchanged orthographic span. These are not fixed CSS
pixel extents. No product, owner, resource-name or composition-group inference selects this mode.

`pivot: [u,v]` defaults to `[0.5,0.5]`, has finite components in `[0,1]`, and uses a bottom-left image origin.
The final rectangle offsets each image UV by `(imageUv - pivot) * projectedSize` from the projected anchor.
Thus `[0.5,0]` expands upward from the bottom-center without moving the world anchor. Pivot neither mirrors nor
rotates UV. Ordinary transparent anchor sprites sort by their actual world anchor, including anchorOffset.
The final rectangle is `F(standard anchor NDC y) + projected local xy extent`. All points share the anchor's view depth and clip
z/w. An anchor before near, behind the eye or beyond far removes the entire billboard, including CPU bounds/pick; an offscreen
anchor whose extent enters the viewport is retained. Zero-scale hidden batch instances remain absent. Both ordinary and
instanced sprites bypass undeformed geometry frustum culling, using the final rectangle for queries. Sprite batches include
semantics/anchor offset in their fingerprint. Current sprite resources do not cast light-space shadows.

The shared inverse terminal is retained: the sprite vertex shader clips its final rectangle to the viewport and maps its y
edges through G into the expanded source target. Its fragment shader evaluates F on source y to recover final-rectangle UV.
The terminal then samples this source once. This preserves straight final boundaries, atlas UV, uncompressed local dimensions
and constant anchor depth without vertex-only curve approximation or a second camera/Scene/RAF. Selective-depth protected
redraw uses exactly the color shader coverage and material alpha/depth settings. Geometry mode is unaffected.

Exact pick uses the declared screen rectangle/depth proxy; its hit point is reconstructed by intersecting the G inverse ray
with the anchor's view-depth plane. This is a display hit point, not a point on the original undeformed quad. Generic
`projectWorldPoint` remains unaware of sprite semantics and round-trips that display point. Positive proximity uses this same
final rectangle in CSS pixels; neither proxy promises per-texel alpha-hole picking. GPU UV/alpha rendering remains material
driven. A non-null fixed-panel anchor combined with anchor-extent is rejected by Display pre-draw and by the backend's update
port (`display-sprite-projection-combination-invalid` / `three-sprite-projection-combination-invalid`).

`benchmark_display_browser.mjs --fixture=anchor` measures both horizontal and vertical raster transitions against mathematical
final rectangles, including corner distances, and checks public hit/project round-trips. It covers ordinary/instanced sprites,
crossing the join and top edge, offscreen centers, near/behind clipping, UV orientation and selective-depth color/pick agreement.
The runner prints machine-specific JSON for perspective/orthographic DPR 1/2 and configurable viewport sizes;
the acceptance limit is one CSS pixel, and results apply to the configurations actually measured.

### Fixed panel compensation

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

Generated data textures use ResourceManager leases and the existing prepareFrame
upload budget. Partial row uploads are complete before a consuming draw; public
readiness waits for a GPU fence with finite polling, and explicit rebuild uploads
the retained CPU source. See [Generated data textures](generated-textures.md) for
the supported formats, failure behavior and memory limits.

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
Display-normalized model overrides may carry `inherit` for depth reads and writes; the backend preserves those values until
the cloned source material is available and then resolves them against that material's original depth state.
`depthTest` and `depthWrite` are Material-owned booleans, independent of Scene composition. Omitted values default to
`true/true` for opaque or masked materials and `true/false` for blended materials. Explicit values are applied unchanged to
sprites, Material Resources, model overrides and standard or water surfaces; the impossible
`depthTest=false, depthWrite=true` pair is rejected by Display and defensively by this backend.

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


Procedural fragment/background programs use the same resource factory and frame path; their closed module, texture, color and time contracts are in [Procedural programs](procedural-programs.md).
