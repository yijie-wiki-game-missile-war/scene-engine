import {
  SceneEngineClient,
  type DisplayAuthorityPort,
  type DisplayCommitGate,
  type DisplaySession,
  type DisplaySessionRuntime,
  type SceneEngineClientOptions,
} from '@scene-engine/client';
import {
  PREFAB_DEFINITION_SCHEMA,
  createComponentRegistry,
  createDisplayRuntime,
  createPrefabRegistry,
  createResourceRegistry,
  createSceneRegistry,
  definePrefab,
  type DisplayRuntimeOptions,
  type DisplayView,
  type PrefabStatePatch,
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

const sceneRegistry = createSceneRegistry();
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

const transformOutput = {
  position: new Float64Array(3),
  rotationXyzw: new Float64Array(4),
  scale: new Float64Array(3),
  matrix: new Float64Array(16),
};
if (clientView !== null) {
  const node = clientView.getNode('py/unit-1');
  if (node !== null) {
    const x: number = node.getWorldTransform().position[0];
    const snapshot: WorldTransform = node.getWorldTransform(null);
    const copied: typeof transformOutput = node.getWorldTransform(transformOutput);
    void [x, snapshot, copied];
  }
  const world = clientView.getWorldTransform('py/unit-1');
  if (world !== false) {
    const matrixEntry: number = world.matrix[0];
    void matrixEntry;
  }
  const copied: false | typeof transformOutput =
    clientView.getWorldTransform('py/unit-1', transformOutput);
  const owner: string | null = clientView.getAuthorityOwner('py/unit-1');
  void [copied, owner, clientView.getComponentState('py/unit-1', 'model'), clientView.snapshot()];

  // @ts-expect-error Output transforms require writable TRS buffers.
  clientView.getWorldTransform('py/unit-1', {});
}

declare const displayContext: PublicDisplayContext;
const contextWorld: false | WorldTransform = displayContext.getWorldTransform('scene/camera');
const contextCopy: false | typeof transformOutput =
  displayContext.getWorldTransform('scene/camera', transformOutput);
void [contextWorld, contextCopy];

declare const runtime: ReturnType<typeof createDisplayRuntime>;
function inspectQueries(queries: Pick<RenderBackendPort, 'pick' | 'projectWorldPoint' | 'focusWorldPoint'>) {
  const hit = queries.pick({ clientX: 0, clientY: 0 });
  if (hit !== null) {
    const name: string = hit.nodeName;
    const distance: number = hit.distance;
    void [name, distance];
  }
  const clientX: number = queries.projectWorldPoint({ position: [0, 0, 0] }).clientX;
  const position: Vec3 = queries.focusWorldPoint({ position: [0, 0, 0], radius: 1 }).position;
  void [clientX, position];
}
inspectQueries(runtime);
inspectQueries(threeBackend);

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
