# Display-local animator contract

The animator is a Display-only visual timeline. It never appears in Python, the wire, the
Client command stream, checkpoints or Replay. Python keeps producing real movement,
trajectories and complex sequences with mathematical expressions; the display side maps
semantic state onto visual timelines.

First version scope, closed:

```text
channel         sprite.frame
interpolation   step
clock           per-player local visualSeconds origin
```

Everything else (state machines, transitions, layers, blend trees, cross fade,
speed/weight/reverse/pause, event tracks, arbitrary property paths, transform or particle
or model-clip channels) is intentionally absent. Future capabilities must join the same
timeline as new closed channels.

## Who owns which time

| Time | Owner |
| --- | --- |
| Real motion, trajectories, gameplay clocks | Python World, `sourceTick` math |
| Local visual timelines (sprite frame replacement) | Display `AnimationSystem`, per-player `visualSeconds` origin |
| Procedural renderer effects (water, noise) | renderer, global `visualSeconds` |
| Procedural particle emitters | renderer instance-local visual origin |

`sourceTick` never advances an animation. Sampling a player uses only
`(frame.visualSeconds - startedAtVisualSeconds)`.

## Resource

One Animation Resource is one timeline. `defineFrameAnimation()` covers uniform frame
replacement:

```js
import { defineResources, defineFrameAnimation } from '@scene-engine/display';

const resources = defineResources({
  schema: RESOURCE_REGISTRY_SCHEMA,
  resources: [
    { id: 'tex.unit', kind: 'texture-atlas', url: './unit.png', columns: 4, rows: 2 },
    defineFrameAnimation({
      id: 'anim.unit.walk',
      target: { node: 'body', component: 'sprite' },
      frames: [0, 1, 2, 1],
      fps: 10,
      loop: true,
    }),
  ],
});
```

`durationMs = frames.length * 1000 / fps` and keyframe `i` sits at `i * 1000 / fps`.
`defineAnimation()` is the low-level escape hatch for unequal dwell times such as
`0 -> 1 -> 2 -> 1`. Both helpers and the ResourceRegistry share one normalizer, and the
descriptor schema is exactly `scene-engine-animation-resource@2`.

Structural rules: non-empty tracks/keyframes, first keyframe at `atMs: 0`, strictly
increasing `atMs` below `durationMs`, non-negative safe-integer frame values, explicit
boolean `loop`, no two tracks writing the same `(channel, node, component)` output.

## Player placement and target scope

The player is a component on the root of one Prefab definition instance. This applies independently to the outer instance and
to every fixed or dynamic nested instance:

```js
const unitPrefab = definePrefab({
  schema: PREFAB_DEFINITION_SCHEMA,
  id: 'unit/basic',
  gameplayType: 'unit',
  root: {
    components: [
      { key: 'animator', type: 'animation.player@1',
        properties: { animationId: 'anim.unit.walk' } },
    ],
    children: [{
      localName: 'body',
      components: [{
        key: 'sprite', type: 'render.sprite@3',
        properties: { textureResourceId: 'tex.unit', width: 1, height: 1, frame: 0 },
      }],
      children: [],
    }],
  },
});
```

- `animation.player@1` is allowed on each Prefab definition-instance root only; ordinary child nodes and plain Scene nodes are
  rejected at compile time.
- `animationId` is `string | null` and must reference a `kind: 'animation'` Resource.
- Track targets are Prefab-local: `{ node: '$root' | localPath, component: key }`.
  Global `py/...` names are never valid targets.
- A player resolves `$root` and local paths only inside its own definition-instance Scope. A parent player cannot cross into a
  nested child instance, and two sibling instances with identical local paths still resolve to different Components.
- The first-version target must be a `render.sprite@3` using a `texture-atlas`; every
  keyframe value must stay below `columns * rows`.

Prefab compile preflights statically declared bindings; runtime `play` preflights any
other animation with the same error codes.

Scope is package-private materialization identity/provenance, not a public tree. The AnimationSystem binds concrete target
Components from that Scope's local-path map. It must not infer an animation root from `node.name.startsWith('prefab/')`, nor
construct a target by prepending another `prefab/` segment. All materialized targets remain ordinary Components in the one
NodeGraph.

## set / play / stop

A Behaviour on the same Node as the player drives it:

```js
class UnitVisualBehaviour extends BehaviourComponent {
  static typeId = 'visual.unit@1';
  static tickPhase = 'update';

  tick() {
    if (this.properties.fireSequence !== this._lastFireSequence) {
      this._lastFireSequence = this.properties.fireSequence;
      this.playAnimation('animator', 'anim.unit.fire');
      return;
    }
    this.setAnimation(
      'animator',
      this.properties.moving ? 'anim.unit.walk' : 'anim.unit.idle',
    );
  }
}
```

| Intent | API | Semantics |
| --- | --- | --- |
| Sustained idle/walk; repeated calls keep the phase | `setAnimation(playerKey, id)` | same id is a no-op |
| One-shot fire/hit/flash; same clip replays from zero | `playAnimation(playerKey, id)` | always restarts |
| Stop and restore base values | `stopAnimation(playerKey)` | clears overrides |

Rules:

- The addressed player must sit on the caller's own Node; commands address it by `key`.
- Commands are synchronous validate-and-enqueue operations and return `void`; the visual
  start point is the next AnimationSystem sample.
- A Behaviour may issue a command from `onAttach` when the same Node's player appears earlier
  in component declaration order. Nested-Prefab candidates validate those commands against an
  isolated complete candidate and replay them only after live adoption; a rejected adoption
  restores the old player identity, clip and visual-time origin.
- Non-loop animations hold their final keyframe; returning to idle needs an explicit
  `setAnimation` or a declarative property patch.
- A runtime stop never rewrites `properties.animationId`; declarative patches keep their
  documented switch semantics (same id keeps the phase, a new id restarts, `null` stops).
- Avoid re-triggering one-shot clips every tick; detect edges (sequence counters) instead
  of replaying on a boolean.

## Overrides and batching

Sampling writes transient overrides, never `component.properties`:

```text
base       = component.properties
override   = AnimationSystem transient value
effective  = { ...base, ...override }   // what the backend receives
```

Stop restores the newest base values. While an animation owns a binding, the internal
render port marks it `batchable: false`; frame flips update only that binding and never
rebuild static batches. Renderer rebuilds remount from the current effective value without
resetting the player phase. `batchable` is not a public Sprite property.

## Lifecycle

| Situation | Result |
| --- | --- |
| Player attaches enabled with an id | starts at frame 0 on the next sample |
| Player disabled | overrides cleared |
| Player re-enabled | declared animation restarts from zero |
| Backend rebuild | phase preserved, effective value remounts |
| Nested instance retained with the same slot key, instance key and `prefabId` | player and phase preserved |
| Retained instance transform, visibility or complete state update | phase preserved unless animation control changes it |
| New nested instance or same key with a different `prefabId` | new player starts from zero |
| Nested instance removed | ownership and transient overrides are released before disposal |
| Staged Prefab materialization adopted | registered exactly once, no accidental restart |
| Prefab destroyed / re-created | new instance starts from zero |
| Whole DisplayRuntime rebuilt | restart allowed |
| Multiple clients | pixel-exact phase not guaranteed |
| Replay/checkpoint | local progress is never serialized |

## Error boundary

Dedicated error codes locate failures by `animationId`, `trackIndex`, node path and
component key:

```text
display-animation-resource-invalid
display-animation-track-invalid
display-animation-keyframes-invalid
display-animation-player-placement-invalid
display-animation-player-missing
display-animation-target-missing
display-animation-target-type-invalid
display-animation-frame-out-of-range
display-animation-output-conflict
display-animation-command-invalid
display-animation-system-unavailable
```

A failed switch keeps the old animation playing; no half-bound state is left behind.

## Future channels (not implemented)

Closed channels such as `node.position`, `sprite.alpha`, `particle.intensity` or
`model.clip` may join this timeline later, each with its own target type, value type and
interpolation. Arbitrary property paths (`children[1].material.opacity`) are out of
contract. Future transform channels may only drive Prefab-internal visual nodes, never
authority roots or real gameplay trajectories.
