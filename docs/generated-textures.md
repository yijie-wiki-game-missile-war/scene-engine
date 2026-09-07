# CPU generated data textures

`scene-engine-generated-texture-resource@1` is closed, renderer-neutral Resource
catalog data. The selected CPU route accepts bounded pixel regions through one
DisplayRuntime. It does not register a JavaScript shader, GPU generator, URL,
worker, render pass or product world model.

```js
const field = {
  id: 'environment/field', kind: 'generated-texture', revision: 1,
  width: 256, height: 256, format: 'rgba32float', usage: 'data',
  initialValue: [-1, 0, 0, 1], filter: 'nearest', wrap: 'clamp',
  budget: { maxUpdateBytes: 1024 * 1024, maxRegions: 16 },
};
// Register before catalog compilation. Bind its ID to a program usage:'data' slot.
// After an accepted source revision, reserve the generation before async work.
const ticket = runtime.generatedTextures.begin(field.id, { sourceRevision: 'world/42' });
// The caller owns bounded CPU derivation outside authority ACK and obeys signal.
const pixels = new Float32Array([-2.5, 0.25, 0, 1]);
ticket.commit({ regions: [{ x: 5, y: 8, width: 1, height: 1, data: pixels }] });
const result = await runtime.generatedTextures.whenReady(field.id);
if (result.status === 'ready') {
  // The active backend's GPU upload fence for this committed revision completed.
}
```

## Descriptor and coordinates

Required fields are `id`, `kind`, `revision`, `width`, `height`, `format`, `usage`,
`initialValue` and `budget`. Optional fields are `schema`, `filter` and `wrap`.
Revision is a positive safe integer. Formats are `rgba8unorm` and `rgba32float`;
usage is exactly `data`. Dimensions are positive integers. `initialValue` has four
finite components, byte integers 0–255 for rgba8, representable finite Float32
values for rgba32. This explicit value initializes every texel; it is not a hidden
fallback. Descriptor defaults, dimensions, initial values and budgets participate
in the existing catalog identity. Runtime pixels do not mutate that identity.

RGBA8 patches require `Uint8Array`; RGBA32 requires `Float32Array`. Regions are
tightly packed row-major RGBA, with x increasing right and y increasing upward
from UV (0,0). No image decode, Y flip, gamma conversion, alpha premultiplication
or mipmap generation is applied. Float values can be signed or exceed 1. The
program owns their interpretation, units and world-to-UV mapping.

`filter` is `nearest` (default) or `linear`; `wrap` is `clamp` (default) or `repeat`.
RGBA32 linear filtering requires `OES_texture_float_linear`; unsupported devices
fail explicitly. GPU upload/fences require WebGL2. These resources bind only named
program data slots. They cannot silently become ordinary color images, sprites,
atlas sources or color slots. A data-to-color conversion belongs in the public
program module, before the engine's normal output terminal.

## Generation, cancellation and atomic visibility

`runtime.generatedTextures.begin(id, {sourceRevision})` synchronously returns a
frozen `{generation, sourceRevision, signal, commit, cancel}` ticket. Generation
strictly increases within that runtime/resource. `sourceRevision` is an opaque,
nonempty string of at most 256 characters identifying the caller's complete
current source. Begin immediately aborts the preceding ticket; reserve it when the
source changes, before starting async derivation. The caller owns CPU tasks and
must cooperate with AbortSignal. The engine does not execute or preempt arbitrary
CPU algorithms and does not copy the authority World.

`commit({regions})` synchronously validates the entire candidate before publication:
closed keys, finite values, exact storage type/length, bounds, region count and byte
budget. SharedArrayBuffer storage is rejected. It copies input data, so subsequent
caller changes cannot alter the accepted source. Overlapping regions merge in
submission order (last writer wins). Invalid candidates throw and retain the prior
complete source and GPU image; the still-current ticket may submit a corrected
candidate. A valid ticket can commit once. Its return is `{status:'staged', generation}`.

New generations retain already accepted regions, including accepted updates not
yet drawn; pending dirty intervals merge per row with bounded memory. Skipped
intermediate generations never produce partial visible patches. A newer valid
region overwrites its covered pixels while preserving untouched pixels. One
generation's complete pending union uploads before any draw using that version;
it is never split into partially visible frames. Merged intervals may upload
unchanged pixels between dirty areas on the same row, but never exceed the complete
texture budget. Initial and restored textures require full upload.

`cancel()` cancels only an unfinished CPU candidate and returns whether it did so.
An already committed candidate is accepted source state and cannot be rolled back
by cancellation. A stale, cancelled or disposed ticket's `commit` returns
`{status:'discarded', generation}` without publishing or attaching anything.
Removing the last GPU resource lease cancels unfinished work. Backend retirement
is a distinct reason and preserves in-flight CPU work and accepted source data.
Removing a lease does not cancel an already committed generation. Its retained
source becomes pending-upload, and attaching it again requires a complete upload
and fence before readiness is restored.

## Scheduling, readiness and failures

Begin/commit are visual resource operations, outside legal authority ACK. They do
not advance sourceTick, mutate Nodes or install another RAF. Commit requests a
draw; the existing prepareFrame phase uploads pending resources within the frame
budget. A whole texture update exceeding the remaining frame budget waits until a
later frame, while the prior complete version stays visible. A texture with no
uploaded initial version prevents the draw until initialization has been submitted.
Initial uploads take priority; resources within that priority rotate each frame.
Once initialized, frequently updated resources also rotate budget priority so a
complete pending update cannot be indefinitely starved by an earlier resource.

`status(id)` returns generation, requested sourceRevision, committedGeneration,
committedSourceRevision, status, errorCode, sampleable and byteLength. States are
`generating`, `pending-upload`, `ready`, `cancelled` and `failed`. `sampleable`
describes a completed upload of some retained version, not necessarily the latest
requested source. A cancellation retains the prior image; it is not a ready result
for the cancelled request.

`whenReady(id)` tracks the requested generation at call time. Concurrent calls for
that generation share one promise. It resolves a status with `ready` only after
the GPU upload fence completes. A superseding generation or removal resolves
`discarded`, runtime disposal resolves `disposed`, and failure resolves `failed`
with an errorCode. Explicitly cancelled requests resolve a cancellation result;
callers must inspect status. An unreferenced resource has no GPU upload and cannot
become ready just because CPU data exists. Runtime must be started and drawing to
complete uploads. The existing `runtime.whenReady()` remains the binding/load
barrier and does not substitute for generated GPU readiness.

An upload polls its WebGL fence only in existing frames, for at most 120 incomplete
polls. Failed upload, wait failure or exhausted fence budget reports recoverable
resource/render health, settles readiness and stops attempts for that backend.
It does not publish a partially updated draw or restart uploads indefinitely.
Rebuild is explicit. The retained complete CPU source is the recovery source;
unsupported format/filter/size errors fail instead of using a different format.
There is no data/blob URL or caller-owned GPU handle.

## Bounded work and lifetime

Hard limits exported as `GENERATED_TEXTURE_LIMITS`:

| Limit | Value |
| --- | ---: |
| Width or height | 2048 texels |
| One texture / one upload transaction | 8 MiB |
| Aggregate declared pixel storage per runtime | 56 MiB |
| Registered generated resources per runtime | 256 |
| Regions per commit | 64, further limited by descriptor |
| Input bytes per commit | 8 MiB, further limited by descriptor |
| Generated upload bytes per frame | 8 MiB |

Descriptor `budget.maxUpdateBytes` and `maxRegions` can lower limits. Validate and
copy work is bounded by commit bytes and region count; dirty bookkeeping is bounded
by texture rows, and each resource retains at most one pending generation rather
than a job backlog. CPU derivation cost itself belongs to the calling algorithm;
it must be bounded and measured separately. The GPU route performs uploads only,
not arbitrary compute. There is no universal frame-time claim.

Accepted CPU pixels and renderer upload arrays each consume at most 56 MiB. One
bounded scratch copy consumes at most 8 MiB, so retained pixel buffers plus the
current transfer stay below 128 MiB, excluding caller input, bounded JavaScript
metadata and driver memory. GPU generated texture storage is at most 56 MiB;
renderer projection targets and other resources retain their separate budgets.
ResourceManager diagnostics count actual generated upload bytes.

Each backend owns and disposes its DataTextures and fences through ResourceManager
leases. The same DisplayRuntime retains CPU pixels/revisions across backend
rebuild, creates fresh GPU leases and reuploads the complete current source before
reporting ready. Pending work cannot attach to a retired backend. Runtime disposal
aborts tickets, settles waiters, clears CPU buffers and releases GPU leases; repeat
dispose remains idempotent. A new runtime/checkpoint session has independent initial
values and generations, requiring fresh derivation from its own source state.

## Verification

Display tests cover descriptor/reference rejection, atomic invalid candidates,
typed copied storage, overlap, dirty row merge, generations, cancellation, removal,
retirement, residency limits and waiter lifetime. Renderer tests verify shared
leases, actual update-range accounting, device rejection, bounded fence failure
and no repeated upload after failure. Public TypeScript consumption is compiled.

`node scripts/benchmark_display_browser.mjs --fixture=generated --dpr=2` runs an
engine-owned public DisplayRuntime fixture with real WebGL. It checks byte and
signed-float samples, local update pixel coverage and upload byte count, invalid
candidate retention, late completion discard, rebuilt pixels/source identity,
single RAF, static idle, disposal cancellation and zero resource leases. It emits
stdout JSON and does not load product assets or algorithms. GPU distance-field
generation and arbitrary generation callbacks remain outside this CPU route.
