import {
  SceneEngineClient,
  type DisplayAuthorityPort,
  type DisplayCommitGate,
  type DisplaySession,
  type DisplaySessionRuntime,
  type SceneEngineClientOptions,
} from '@scene-engine/client';
import {
  DisplayTransform,
  PREFAB_DEFINITION_SCHEMA,
  PointerNodeEventHub,
  createComponentRegistry,
  createDisplayKindRegistry,
  createDisplayRuntime,
  createPointerInteractionController,
  createPrefabRegistry,
  createResourceRegistry,
  createSceneRegistry,
  definePrefab,
  type DisplayTransform as DisplayTransformValue,
  type DisplayRuntimeOptions,
  type DisplayView,
  type PrefabStatePatch,
  type PointerInteractionSample,
  type PublicDisplayContext,
  type RenderBackendPort,
  type Vec3,
  type WorldTransform,
} from '@scene-engine/display';
import {
  createThreeRenderBackend,
  type ThreeRenderBackendPort,
} from '@scene-engine/renderer-three';

declare const hostElement: unknown;
declare const canvas: unknown;
declare const pointerElement: Element;

const authoredTransform: DisplayTransformValue = DisplayTransform.fromTRS({
  position: [1, 2, 3],
  rotationXyzw: [0, 0, 0, 1],
  scale: [2, 2, 2],
});
const movedTransform: DisplayTransformValue =
  DisplayTransform.translatedSelf(authoredTransform, [0, 0, 1]);
const transformedPoint: Vec3 = DisplayTransform.transformPoint(movedTransform, [0, 0, 0]);
const localPoint: Vec3 = DisplayTransform.inverseTransformPoint(movedTransform, transformedPoint);
declare const worldMatrix64: Float64Array;
const worldPointFromF64: Vec3 = DisplayTransform.transformPoint(worldMatrix64, [0, 0, 0]);
void [authoredTransform, movedTransform, transformedPoint, localPoint, worldPointFromF64];

const sceneRegistry = createSceneRegistry();
const displayKindRegistry = createDisplayKindRegistry();
const prefabRegistry = createPrefabRegistry();
const resourceRegistry = createResourceRegistry();
const componentRegistry = createComponentRegistry();
const authorityStateSchemas = [] as const;

const backendFactory: DisplayRuntimeOptions['createRenderBackend'] = createThreeRenderBackend;
declare const threeBackend: ThreeRenderBackendPort;
const backendPort: RenderBackendPort = threeBackend;
void backendPort;

function createProductDisplaySession() {
  const runtime = createDisplayRuntime({
    hostElement,
    canvas,
    sceneRegistry,
    displayKindRegistry,
    prefabRegistry,
    resourceRegistry,
    componentRegistry,
    authorityStateSchemas,
    createRenderBackend: backendFactory,
  });

  const authorityPort: DisplayAuthorityPort = runtime.authority;
  const commitGate: DisplayCommitGate = runtime.commitGate;
  return {
    runtime,
    authorityPort,
    commitGate,
    dispose: () => runtime.dispose(),
    debugName: 'main-projection',
  };
}

const createDisplaySession: SceneEngineClientOptions['createDisplaySession'] =
  createProductDisplaySession;
const client = new SceneEngineClient({ createDisplaySession });
const clientView: DisplayView | null = client.currentDisplayView();
const capturedView: DisplayView | null = client.capture().displayView;
void capturedView;

const transformOutput = new Float64Array(16);
if (clientView !== null) {
  const node = clientView.getNode('py/unit-1');
  if (node !== null) {
    const x: number = node.getWorldTransform()[12];
    const snapshot: WorldTransform = node.getWorldTransform(null);
    const copied: typeof transformOutput = node.getWorldTransform(transformOutput);
    void [x, snapshot, copied];
  }
  const world = clientView.getWorldTransform('py/unit-1');
  if (world !== false) {
    const matrixEntry: number = world[0];
    void matrixEntry;
  }
  const copied: false | typeof transformOutput =
    clientView.getWorldTransform('py/unit-1', transformOutput);
  const owner: string | null = clientView.getAuthorityOwner('py/unit-1');
  void [copied, owner, clientView.getComponentState('py/unit-1', 'model'), clientView.snapshot()];

  // @ts-expect-error Output transforms require a writable 16-value numeric buffer.
  clientView.getWorldTransform('py/unit-1', {});
}

declare const displayContext: PublicDisplayContext;
const contextWorld: false | WorldTransform = displayContext.getWorldTransform('scene/camera');
const contextCopy: false | typeof transformOutput =
  displayContext.getWorldTransform('scene/camera', transformOutput);
void [contextWorld, contextCopy];

declare const runtime: ReturnType<typeof createDisplayRuntime>;
function inspectQueries(queries: Pick<RenderBackendPort,
  'pick' | 'pickProximity' | 'screenPointToWorldRay'
  | 'projectWorldPoint' | 'focusWorldPoint'>) {
  const hit = queries.pick({ clientX: 0, clientY: 0 });
  if (hit !== null) {
    const name: string = hit.nodeName;
    const distance: number = hit.distance;
    void [name, distance];
  }
  const proximity = queries.pickProximity({ clientX: 0, clientY: 0, radiusPixels: 12 });
  const direction: Vec3 = queries.screenPointToWorldRay({ clientX: 0, clientY: 0 }).direction;
  const clientX: number | null = queries.projectWorldPoint({ position: [0, 0, 0] }).clientX;
  const position: Vec3 = queries.focusWorldPoint({ position: [0, 0, 0], radius: 1 }).position;
  void [proximity?.screenDistancePixels, direction, clientX, position];
}
inspectQueries(threeBackend);

const interaction = runtime.pickInteraction({ clientX: 0, clientY: 0 });
const nearbyInteraction = runtime.pickInteractionProximity({
  clientX: 0,
  clientY: 0,
  radiusPixels: 12,
});
const runtimeRayDirection: Vec3 = runtime.screenPointToWorldRay({
  clientX: 0,
  clientY: 0,
}).direction;
void [interaction?.target?.data, nearbyInteraction?.hit.screenDistancePixels,
  runtimeRayDirection];

const pointerNodeEvents = new PointerNodeEventHub();
const removePointerListener = pointerNodeEvents.addEventListener(7, 'click', (event) => {
  void event.payload.currentInteraction;
});
removePointerListener();

const pointerController = createPointerInteractionController({
  element: pointerElement,
  runtime: () => runtime,
  nodeEventHub: pointerNodeEvents,
  claim(sample) {
    const phase: PointerInteractionSample['phase'] = sample.phase;
    return phase === 'press' ? { selected: true } : null;
  },
  onDragGrab(token, sample) { void [token.selected, sample.startInteraction]; },
  onDragMove(token, sample) { void [token.selected, sample.currentInteraction]; },
  onDragDrop(token, sample) { void [token.selected, sample.worldRay.direction]; },
  onClick(token) { void token.selected; },
  onContextClick(token) { void token.selected; },
  onDoubleClick(token) { void token.selected; },
  onProximityEnter(sample) { void sample.currentInteraction; },
  onProximityMove(sample) { void sample.deltaClientX; },
  onProximityLeave(sample) { void sample.reason; },
  onNodeEvent(event) { void [event.nodeId, event.eventName, event.payload.phase]; },
  sendInput(input) {
    void client.encodeInput({ inputId: 'pointer:1', ...input });
  },
});
pointerController.dispose();

const prefab = definePrefab({
  schema: PREFAB_DEFINITION_SCHEMA,
  id: 'typecheck/unit',
  gameplayType: 'unit',
  root: { components: [], children: [] },
  resolveState: (state) => state.hidden === true ? null : { components: {} },
});
const patch: PrefabStatePatch = prefab.resolveState({ hidden: true });
void patch;

const asynchronousCleanup: DisplaySession['dispose'] = async () => {};
void asynchronousCleanup;

// @ts-expect-error Authority creation is a synchronous barrier.
const asynchronousCreate: DisplayAuthorityPort['createNode'] = async () => 'py/invalid';
void asynchronousCreate;

// @ts-expect-error Scene installation is a synchronous barrier.
const asynchronousInstall: DisplaySessionRuntime['installScene'] = async () => createProductDisplaySession().runtime;
void asynchronousInstall;


function generatedTextureTypeCheck(runtime: import('@scene-engine/display').DisplayRuntime,
  registry: import('@scene-engine/display').ResourceRegistry) {
  const resource: import('@scene-engine/display').GeneratedTextureResourceDescriptor = {
    id: 'typed/data', kind: 'generated-texture', revision: 1, width: 4, height: 4,
    format: 'rgba32float', usage: 'data', initialValue: [-1, 0, 0, 1],
    budget: { maxUpdateBytes: 256, maxRegions: 4 },
  };
  registry.register(resource);
  const ticket = runtime.generatedTextures.begin(resource.id, { sourceRevision: 'world/1' });
  ticket.commit({ regions: [{ x: 0, y: 0, width: 1, height: 1, data: new Float32Array([-2, 0, 0, 1]) }] });
  const ready: Promise<import('@scene-engine/display').GeneratedTextureStatus |
    Readonly<{ status: 'discarded' | 'disposed'; generation: number }>> = runtime.generatedTextures.whenReady(resource.id);
  void ready;
  // @ts-expect-error generated regions require typed CPU pixel storage
  ticket.commit({ regions: [{ x: 0, y: 0, width: 1, height: 1, data: [0, 0, 0, 1] }] });
  // @ts-expect-error source revisions are explicit opaque identities
  runtime.generatedTextures.begin(resource.id, { sourceRevision: 3 });
}

const programSprite: import('@scene-engine/display').SpriteProperties = {
  materialResourceId: 'material/cloud', projectionSemantics: 'anchor-extent',
  width: 4, height: 2, pivot: [0.5, 0], parameters: { phase: 1 },
};
const ordinarySprite: import('@scene-engine/display').SpriteProperties = {
  textureResourceId: 'texture/card', width: 4, height: 2, frame: 1,
};
const spriteDefinition: import('@scene-engine/display').ComponentDefinition<import('@scene-engine/display').SpriteProperties> = {
  key: 'sprite', type: 'render.sprite@3', properties: programSprite,
};
// @ts-expect-error Sprite resource branches are mutually exclusive.
const mixedSprite: import('@scene-engine/display').SpriteProperties = { ...programSprite, textureResourceId: 'texture/card' };
// @ts-expect-error Program sprites require anchor extent projection.
const geometryProgramSprite: import('@scene-engine/display').SpriteProperties = { materialResourceId: 'material/cloud', width: 4, height: 2 };
// @ts-expect-error Program materials own alpha, rather than a second inline alpha field.
const inlineAlphaSprite: import('@scene-engine/display').SpriteProperties = { ...programSprite, alpha: 0.5 };
// @ts-expect-error Geometry sprites cannot declare a projected pivot.
const geometryPivotSprite: import('@scene-engine/display').SpriteProperties = { ...ordinarySprite, projectionSemantics: 'geometry', pivot: [0.5, 0] };
void [programSprite, ordinarySprite, spriteDefinition, mixedSprite, geometryProgramSprite, inlineAlphaSprite, geometryPivotSprite];
