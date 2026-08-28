# Three RenderBackend 0.9.3

`@scene-engine/renderer-three@0.9.3` is the browser composition-root implementation of Display's flat RenderBackendPort. Its
root exports only:

```text
THREE_RENDER_BACKEND_SCHEMA
ThreeRenderBackendError
createThreeRenderBackend
```

The package also publishes `src/index.d.ts`.

## Boundary

The factory accepts DOM host, canvas, renderer profile, ResourceRegistry, lifecycle AbortSignal and a health observer. It returns
13 methods used by DisplayRuntime:

```text
createBinding / updateBinding / destroyBinding
prepareFrame / render / requestResize
pick / projectWorldPoint / focusWorldPoint / capture
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

Display passes an Engine-computed world matrix, logical visibility and already normalized closed component properties. Display
must reject invalid business records before commit seal; the backend repeats defensive shape/resource checks to protect its own
boundary and asset-loading failures.

## Binding representation

Each RenderComponent owns one logical binding `(nodeName, componentKey)`. Logical visibility is independent of representation:

```text
ordinary object drawable = visible && !batched
batch instance drawable  = visible && batched
```

An ordinary object and its `InstancedMesh` instance are alternatives, never two visual parts. Batch creation hides the ordinary
object; a hidden instance uses a zero matrix; leaving or disposing the batch restores the ordinary object according to logical
visibility. Ordinary picking excludes batched records, and instance hits map back to the same logical binding.

## Resources and time

Resource loads honor AbortSignal and generation tokens. Removing a pending binding prevents late attachment; destroy/recreate
for one identity is serialized. URL textures are decoded with one consistent vertical-orientation rule. Source model material
semantics remain unless closed component properties explicitly override them.

Simulation animation uses `sourceTick / TICKS_PER_SECOND`; visual-only animation may use `visualSeconds`. Neither renderer
time source mutates World state. `TICKS_PER_SECOND` remains an internal variable equal to the fixed contract value 60.

`prepareFrame(frame)` consumes dirty bindings and the active camera; parameterless `render()` performs the requested draw from
that prepared state. Picking returns plain
`{nodeName, componentKey, point, distance}` data or `null`; project/focus/capture/diagnostics also return plain data only.

Backend health can trigger `DisplayRuntime.rebuildRenderBackend()`, which preserves Display Node/Component identity and remounts
bindings. Disposal aborts pending work and releases renderer, geometry, material, texture, binding and listener ownership.
