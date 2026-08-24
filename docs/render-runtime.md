# Three RenderBackend 0.9

`@scene-engine/renderer-three@0.9.0` exports only:

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

Supported public component types are model, mesh, sprite, surface, particle, camera, background, ambient light, directional
light, point light and spot light. Resource loads honor AbortSignal and generation tokens. Removing a pending binding prevents
late attachment; destroy/recreate for the same identity is serialized. Source model material semantics are retained unless
closed component properties explicitly override alpha/depth behavior.

`prepareFrame` consumes only dirty bindings and the active camera binding. `render` performs the draw requested by
DisplayRuntime. A picking hit returns `{nodeName,componentKey,point,distance}` and a miss returns `null`; projection/focus
return plain data. Backend failure is reported
through health and can invoke `DisplayRuntime.rebuildRenderBackend()`, which preserves Node/Component identity and remounts
declarative bindings. Disposal aborts pending work and releases renderer, geometry, material, texture and listener ownership.
