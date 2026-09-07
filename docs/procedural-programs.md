# Procedural programs

Program Resource `scene-engine-program-resource@1` is renderer-neutral catalog data.
The initial `glsl-module@1` language supports fragment evaluation for background and
surface stages. It is not a user-defined render pass, vertex entry point, JavaScript
callback or a second scene. Source, revision, schema, defaults, names and texture
references participate in the existing canonical catalog identity.

```js
const program = {
  id: 'environment/program', kind: 'program', revision: 1,
  language: 'glsl-module@1', stage: 'background', timeChannel: 'water',
  parameterSchema: {
    level: { type: 'float', default: 0.2, min: 0, max: 1, updateable: true },
  },
  textureSlots: {},
  source: `vec4 evaluate(ProgramInput data) {
    return vec4(vec3(p_level + 0.02 * sin(data.visualSeconds)), 1.0);
  }`,
};
// ResourceRegistry registration precedes component/catalog compilation.
const backgroundProperties = {
  programResourceId: program.id, textures: {}, parameters: { level: 0.3 },
}; // render.background@1
```

`stage:'surface'` uses the same evaluator with a `material.program` material
Resource containing `programResourceId`, named `textures`, `parameters` and normal
material `properties`. `render.mesh@1` takes that material and an existing mesh
Resource; its optional `parameters` override only updateable entries. Programs do
not displace vertices. Ordinary billboard Components can orient their mesh Nodes.
Eligible opaque/masked program meshes with depth testing and writing enabled can
share an instance batch. Blended or depth-order-dependent program materials remain
ordinary so each object retains its ordering against external drawables.

## Program sprites

`render.sprite@3` may use `materialResourceId` instead of `textureResourceId` to reference a surface-stage
`material.program`. This closed branch requires `projectionSemantics:'anchor-extent'`, positive `width`/`height`,
and accepts `anchorOffset`, `pivot`, `parameters`, `renderOrder` and `pickable`. It rejects inline `material`,
`alpha` and `frame`; named texture selection and material tint/opacity have one owner in the Material Resource.
`parameters` only overrides updateable material defaults. Program sprites remain ordinary drawables, including
opaque/masked variants, and share the existing anchor coverage, depth, sorting and queries with texture sprites.

`pivot` is normalized image position from the bottom-left, defaults to `[0.5,0.5]`, and each component is in `[0,1]`.
It changes post-projection extent, never the world anchor or UV orientation. `ProgramInput.hasAnchor` is true for
these sprites; `anchorWorldPosition` is their common world anchor. Mesh/background programs receive false and
`vec3(0)` respectively. Sprite `uv` is the original image rectangle coordinate, independent of pivot and clipping.
Sprite `worldPosition` is the inverse pixel ray's intersection with the anchor view-depth plane, matching the
public display-hit proxy. Other stages retain their existing worldPosition and UV meanings.

The following declarations combine associated color sampling, a surface program and a bottom-biased pivot.
Register the Resources before compiling the Sprite Component; attach that Component through the existing Scene/Prefab API.

```js
const resources = createResourceRegistry([
  { id: 'image', kind: 'texture', url: './image.png', colorSpace: 'srgb',
    alphaEncoding: 'straight', alphaSampling: 'premultiplied',
    minFilter: 'linear', magFilter: 'linear', mipmaps: false },
  { id: 'image-program', kind: 'program', revision: 1,
    language: 'glsl-module@1', stage: 'surface', parameterSchema: {},
    textureSlots: { image: { usage: 'color' } },
    source: 'vec4 evaluate(ProgramInput data) { return texture2D(t_image, data.uv); }' },
  { id: 'image-material', kind: 'material', family: 'material.program',
    programResourceId: 'image-program', textures: { image: 'image' }, parameters: {},
    properties: { alphaMode: 'blend', depthTest: true, depthWrite: false } },
]);
const sprite = { key: 'image', type: 'render.sprite@3', properties: {
  materialResourceId: 'image-material', width: 2, height: 1,
  projectionSemantics: 'anchor-extent', anchorOffset: [0, 0, 0], pivot: [0.5, 0.2],
} };
```

Import `createResourceRegistry` from `@scene-engine/display`. The complete public Runtime GPU example is
[scripts/support/program_sprite_browser_validation.mjs](../scripts/support/program_sprite_browser_validation.mjs),
served by the existing `--fixture=program-sprite` browser runner, including against isolated installed tarballs.

## Program mesh batching

Program batches group the same mesh and material Resources, composition group,
immutable parameter values and presentation flags. Mutable instance parameters do
not participate in the grouping key. Display's existing `batchable:false` flag keeps
an animated override ordinary; changing eligibility, material references or static
presentation can rebuild representation while preserving the logical binding and
pick identity. Blended program materials, or those with `depthTest:false` or
`depthWrite:false`, are never automatically instanced: an InstancedMesh cannot
interleave its members with external drawables. Their declared depth flags remain
unchanged on the ordinary path.

The backend transports updateable parameters through one private float data texture
with one fixed-schema row per instance. Scalars, vectors, colors and fixed arrays
retain their existing types; integer values use two exact 16-bit parts to match
ordinary WebGL integer uniforms without float32 precision loss. An instance update
writes only its changed row and marks that row for partial upload. Time-only frames
do not upload parameter data, alter shader source or rebuild membership. Batch size
is bounded by the GPU texture height limit; larger groups are split. This internal
transport is owned and disposed with the batch and is not a public generated Resource.

Named textures keep the original material Resource leases, sampler/color/alpha
semantics and output terminal. Instance matrices contribute to world position and
the normal projection path. Each batch receives the same prepared camera/viewport
and channel time as ordinary programs; rebuilding a batch does not reset time.
Hidden members use the existing zero-matrix representation and cannot be picked;
when all time-using members are hidden or paused they do not request continuous draw.
An incrementally maintained visible-member count disables the batch object when
all members are hidden, so even an explicitly requested draw submits no world
triangles for that batch. Hidden rows do not upload parameters; a member becoming
visible receives its latest values. An entirely hidden batch also skips time and
frame-uniform sampling until visible again.

## Closed inputs and bounds

Every parameter declares `type`, `default`, and `updateable`. Numeric types also
require finite scalar `min` and `max`; bounds apply to every component. Supported
types are `float`, `int`, `bool`, `vec2`, `vec3`, `vec4`, and `color` (linear RGB
vec3). `int` defaults, bounds and updates must be integers in `[-2147483648,2147483647]`, matching GPU transport. Optional `length` declares an exact, fixed array length from 1 through 64.
One program may declare at most 256 scalar parameter components in total. The
GLSL parameter symbol is `p_<name>`; fixed arrays use normal array indexing. Invalid values,
unknown keys, illegal vector/array lengths and immutable overrides fail at Display
normalization before state exposure. Surface material defaults may configure
immutable parameters; component updates must preserve their configured value.

Named `textureSlots` declare `{usage:'color'|'data'}`; bindings map each name to one
Texture Resource ID. Missing, extra, wrong-kind or encoding-incompatible references
fail synchronously. A program has at most eight texture slots. Color slots require
explicit `colorSpace:'srgb'`; data slots require explicit `colorSpace:'linear'`.
`texture2D(t_<name>, uv)` samples the named slot. Atlas selection is explicit UV
math over an ordinary Texture Resource; atlas Resource wrappers are not accepted.

Texture descriptors separately declare `minFilter` (nearest/linear plus the four
nearest/linear mipmap combinations), `magFilter:'nearest'|'linear'`, and
`mipmaps:boolean`. Existing `filter:'nearest'|'linear'` is a shorthand and cannot
be combined with min/mag fields. Mipmap minification with `mipmaps:false` fails.
Defaults retain linear filtering and mipmaps. `wrap` accepts one mode or `{s,t}`
with clamp/repeat/mirror. Atlas selection is explicit UV math: reserve padding at
every used mip level, inset sampling to the cell, or disable mipmaps where no safe
mip chain exists. Engine does not infer cell borders from image content.

`alphaEncoding:'straight'|'premultiplied'` declares the source **encoded RGB**
convention; defaults are straight. For a program color slot,
`alphaSampling:'premultiplied'` opts into associated linear filtering, and a
premultiplied source implies it. This path requires explicit sRGB, a bounded image
of at most 4,194,304 pixels, and direct `texture2D(t_name, uv[, bias])` calls.
Passing that sampler through arbitrary sampler helpers is rejected synchronously.
Ordinary materials/sprites/atlas wrappers reject associated sampling explicitly;
their existing straight-alpha behavior remains available.

Decode disables browser color conversion/premultiplication and applies one Y flip.
For associated sampling the backend normalizes source RGB to straight encoded RGB,
sRGB-decodes, multiplies linear RGB by alpha, then encodes the associated color for
sRGB texture storage. Alpha-zero RGB is zero. GPU decoding, filtering and generated
mips therefore operate on associated linear values. Engine's named sampler wrapper
returns **straight linear RGBA** to the evaluator; programs return straight linear
RGBA, and the existing material blend convention applies alpha once. Upload never
performs another premultiplication. Linear data slots bypass this normalization
and the sRGB curve. The bounded CPU normalization buffer is owned by the texture
lease and released with it.

Source is at most 65,536 characters and declares `vec4 evaluate(ProgramInput data)`
plus ordinary GLSL helper functions. It can use math, texture sampling, derivatives,
branches and static loops. A loop has the form `for(int i=0;i<N;i++)`, with a literal
N no greater than 64. There are at most eight loops and the conservative product
of their bounds must not exceed 4096. Unknown `p_`/`t_` references fail synchronously.
Main functions, preprocessor directives, engine `se_`/`gl_` names, uniform/attribute
declarations, discard and unbounded loops are rejected. GLSL syntax/type errors are
GPU compilation failures; registration is not a complete GLSL compiler. Do not use
reserved GLSL words such as `input` as variable names.

The engine supplies `ProgramInput`:

| Field | Meaning |
| --- | --- |
| `visualSeconds` | Prepared Display channel sample, independent of sourceTick |
| `worldPosition` | Interpolated mesh surface point; program sprite display-plane intersection; background primitive position has no world-surface meaning |
| `uv` | Mesh UV, or original final-image rectangle UV for program sprites |
| `hasAnchor`, `anchorWorldPosition` | `bool` and `vec3`: program sprite world anchor; false and `vec3(0)` on mesh/background |
| `rayOrigin`, `rayDirection` | Current effective camera ray; normalized direction, per-pixel near-plane origin for orthographic cameras |
| `cameraPosition` | Camera world origin for either projection |
| `screenUv` | Final viewport coordinates, bottom-left origin, normalized to 0–1 |
| `viewportCss`, `viewportBuffer` | Final viewport dimensions in CSS and drawing-buffer pixels |
| `viewportCssOrigin`, `viewportBufferOrigin` | `vec2`: client-space top-left of the host viewport; drawing-buffer bottom-left `(0,0)` respectively. CSS origin is refreshed each draw, including host movement without resize. |
| `cameraWorldMatrix`, `viewMatrix` | `mat4`: camera-to-world transform and its inverse from the effective camera |
| `projectionMatrix`, `inverseProjectionMatrix` | `mat4`: actual linear world-pass projection and inverse, including upper-field source-frustum expansion |
| `projectionMode` | `int`: `0` perspective, `1` orthographic |
| `projectionParameters` | `vec4(near, far, fovYRadians, orthoHeight)`. FOV is zero for orthographic; height is zero for perspective. These describe the declared linear camera before source expansion. |
| `projectionProfile` | `vec3(startNdcY, strength, sourceSpan)`. Disabled profile is `(0,0,2)`; source NDC converts to original NDC Y as `(sourceNdcY+1)*sourceSpan/2-1`, then the shared forward function determines final Y. |

With upper-field enabled the backend expands the same camera frustum and evaluates
world/background fragments in its source target. Ray reconstruction uses that
effective inverse projection. `screenUv` maps source coordinates through the same
upper-field forward function used by the final view. Owners must not apply another
inverse or vertex warp. Engine main handles material tint, opacity, mask cutoff,
linear RGB output and the renderer's tone/color terminal. Background uses one
unpickable fullscreen primitive inside the same Scene, first in the initial
composition pass, with depth test/write disabled. Only one background binding is
allowed. It does not use the geometry far plane to determine an environment horizon;
the evaluator must bound its own near-horizontal ray/plane arithmetic.

Camera matrices are copied before terminal restoration. Backgrounds, ordinary
surfaces and instance batches receive the same frame object per world pass.
These fields are read-only engine inputs, never user parameter overrides.
The matrices represent the linear rasterization pass; the nonlinear upper-field
mapping is explicitly represented by `projectionProfile`, not by a fictitious
4×4 matrix. See `program-frame.test.mjs` and the real GPU runner
`node scripts/benchmark_display_browser.mjs --fixture=program-frame`, which checks
matrix inverses and public `projectWorldPoint` agreement across projection modes,
profile enable/disable, moved nested hosts, resize and all three program paths.

## Transient program parameters

An attached, enabled Behaviour may call
`this.setProgramParameters(renderKey, patch)` for a same-Node program mesh or
background Component, or program sprite Component. The entire patch is validated against its program's
updateable numeric schema before exposure; unknown/static fields and a second
Behaviour owner fail. Patches merge with that Behaviour's retained values.
`null` releases the claim and reveals the current authoritative/base parameters.
These values belong to Display's rendering layer: they do not change Component
properties, catalog identity, sourceTick or ACKs, and remain eligible for program
batching. They survive backend rebuild and retained Prefab reconciliation. Disable,
detach, dispose or changing the target's program releases ownership. Calls before
attachment/registration, including staged `onAttach`, are rejected; use the existing
post-ACK Behaviour frame phases for world-derived inputs. No public uniform map or
second scene graph is exposed.

## Time and resource ownership

Program GPU compilation is checked before the material enters a draw. A failure
isolates bindings referencing that program Resource ID/revision; their logical
identity remains installed, but they do not draw, pick or request continuous
frames. Other resources keep rendering and Authority commits can still ACK.
Each failed resource emits one bounded warning with `resourceId`, `revision`,
`programStage`, representative `nodeName`/`componentKey`, `affectedBindingCount`,
`isolation:'program'` and at most 4096 characters of compiler `diagnostic`.
No complete shader dump or automatic recompile loop is emitted. Replacing the
binding with a valid resource restores it; explicit backend rebuild starts a new
compile attempt. Shared terminal/device failures retain the backend failure path.
The GPU `program-batch` fixture covers failed background and instance material
alongside healthy geometry, repeat frames and corrected resource replacement;
`program-isolation.test.mjs` covers the Display health bridge and subsequent ACK.

DisplayRuntime creates one visual channel for every declared program `timeChannel`
(default `default`). `runtime.setVisualTimeControl(channel, control)` accepts
optional `paused`, finite `rate` from 0 to 16, and `freezeSeconds` (nonnegative finite
number or null). It samples the prior phase before changing a control, so pause,
resume and rate changes are continuous. Clearing a fixed sample resumes from that
sample. The return value is `{seconds,running}`. Unknown channels and invalid
controls fail without changing existing state. The same runtime retains channel
state through backend rebuild. Animation players retain their existing timeline
contract; these controls address procedural channels only.

`runtime.setVisualTimePaused(boolean)` pauses/resumes every procedural channel
atomically at one shared Display sample. Each channel keeps its independent rate,
local pause and fixed sample. Resuming does not unpause a locally paused channel or
clear a fixed sample; edits made while globally paused take effect on the preserved
phase. This is a gate on the existing channels, not another accumulating clock.

Each frame forwards an immutable `visualTimes` map beside `visualSeconds`; programs
consume it once during prepareFrame. Repeated color/depth composition passes never
advance time. Paused and hidden procedural handles stop requesting continuous draw;
explicit scene `drawMode:'continuous'` still requests frames. The next requested
frame samples paused handles as well, allowing resume without a separate loop.

ResourceManager leases own program/texture dependencies, async cancellation and
late completion. Material instances own separate numeric uniforms and share texture
leases; numeric updates do not reload textures or mark materials for recompilation.
Resource release and backend disposal keep the existing generation/AbortSignal and
idempotent disposal boundaries. GPU compile failure is observed through renderer
health; it does not hold legal authority ACKs.

## Verification and current limits

Display tests cover closed schemas, invalid input, parameter mutability, named
texture kinds/encodings and independent pause/rate/freeze. Renderer tests cover
camera-frame delivery, idle/resume, per-instance isolation, stable material program
version and shared texture disposal. Real WebGL validation runs with
`node scripts/benchmark_display_browser.mjs --fixture=program --dpr=2`: it draws
ray-based sky/plane color, checks exact fixed-time repeats, changing time, fullscreen
coverage, one camera/background, GPU errors and resource release. The runner prints
JSON; it does not prove a product's particular V09 shader or coast algorithm.

The `program-batch`, `anchor`, `texture-alpha` and `generated` browser fixtures
exercise the additional public capabilities with real WebGL. Alpha fixtures use
static deterministic PNGs, both source conventions, multiple scales/opacities and
backgrounds, a color card, linear data and an explicitly inset atlas cell. Machine
measurements are runner output rather than universal FPS guarantees.

Generated data textures support caller-owned CPU computation and bounded region
uploads under the [generated texture contract](generated-textures.md). Arbitrary pass graphs, GPU field-generation kernels
and vertex displacement remain outside this release. Product coast geometry,
field construction, visual matching and full production acceptance belong to Arts;
Engine's generic fixtures cannot establish those product results.
