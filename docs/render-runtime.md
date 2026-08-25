# Three RenderBackend 0.9.1

`@scene-engine/renderer-three@0.9.1` exports only:

```text
THREE_RENDER_BACKEND_SCHEMA
ThreeRenderBackendError
createThreeRenderBackend
```

The factory accepts the public Display backend options: DOM host, canvas, renderer profile, ResourceRegistry and lifecycle
AbortSignal. It returns the 13-method RenderBackend port used by DisplayRuntime.

Each RenderComponent owns one flat binding identified by `(nodeName, componentKey)`. The backend receives an Engine-computed
world matrix, visibility and closed component properties. It does not reconstruct Node parents, run Component handlers,
schedule RAF, own product controls, infer default lights, or expose Scene/Camera/Object3D/Material/Texture values.

Logical visibility is independent of the selected Three representation. For each binding:

```text
ordinary object drawable = record.visible && !record.batched
batch instance drawable  = record.visible && record.batched
```

An ordinary object and its `InstancedMesh` instance are alternative representations of one RenderComponent, never two visual
parts. Creating a batch hides the retained ordinary object. Transform, visibility, property and resource-replacement updates
must preserve that state; no update path may set the ordinary object directly from logical visibility. A hidden batch member
uses a zero matrix. Batch exit or disposal clears the batch state and restores the ordinary object according to logical
visibility. Display Core never receives `batched`, `InstancedMesh` or another renderer-specific state field.

Supported public component types are model, mesh, sprite, surface, particle, camera, background, ambient light, directional
light, point light and spot light. Resource loads honor AbortSignal and generation tokens. Removing a pending binding prevents
late attachment; destroy/recreate for the same identity is serialized. Source model material semantics are retained unless
closed component properties explicitly override alpha/depth behavior.

`prepareFrame` consumes only dirty bindings and the active camera binding. `render` performs the draw requested by
DisplayRuntime. Ordinary picking excludes batched records, and batch picking maps its instance back to the same logical
binding, so one binding can produce at most one hit. A hit returns `{nodeName,componentKey,point,distance}` and a miss returns
`null`; projection/focus return plain data. Backend failure is reported
through health and can invoke `DisplayRuntime.rebuildRenderBackend()`, which preserves Node/Component identity and remounts
declarative bindings. Disposal aborts pending work and releases renderer, geometry, material, texture and listener ownership.
