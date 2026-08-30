export type JSONPrimitive = null | boolean | number | string;
export type JSONValue = JSONPrimitive | readonly JSONValue[] | { readonly [key: string]: JSONValue };
export type JSONRecord = { readonly [key: string]: JSONValue };

export type Vec3 = readonly [number, number, number];
export type QuaternionXyzw = readonly [number, number, number, number];
export type Matrix4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export interface DisplayTransform {
  readonly position: Vec3;
  readonly rotationXyzw: QuaternionXyzw;
  readonly scale: Vec3;
}

export interface WorldTransform extends DisplayTransform {
  readonly matrix: Matrix4;
}

export interface MutableNumericArray {
  readonly length: number;
  [index: number]: number;
}

export interface WorldTransformOutput {
  readonly position: MutableNumericArray;
  readonly rotationXyzw: MutableNumericArray;
  readonly scale: MutableNumericArray;
  readonly matrix?: MutableNumericArray;
}

export interface DisplayCursor {
  readonly commitSeq: number;
  readonly sourceTick: number;
  readonly lastCommandSeq: number;
}

export interface DisplayCatalogIdentity {
  readonly sceneCatalogHash: string;
  readonly prefabCatalogHash: string;
  readonly stateSchemaHash: string;
}

export interface DisplayCatalogIdentityRecord {
  readonly scene_catalog_hash: string;
  readonly prefab_catalog_hash: string;
  readonly state_schema_hash: string;
}

export interface AuthorityStateSchema {
  readonly gameplayType: string;
  readonly schemaId: string;
  readonly revision: number;
}

export interface DisplayCatalogManifest {
  readonly schema: typeof DISPLAY_CATALOG_MANIFEST_SCHEMA;
  readonly scenes: readonly Readonly<Record<string, unknown>>[];
  readonly prefabs: readonly Readonly<Record<string, unknown>>[];
  readonly resources: readonly Readonly<Record<string, unknown>>[];
  readonly components: readonly Readonly<Record<string, unknown>>[];
  readonly authorityStateSchemas: readonly AuthorityStateSchema[];
}

export interface RendererProfile {
  readonly drawMode: 'requested' | 'continuous';
  readonly maximumPixelRatio: number;
  readonly clearRgba: number;
  readonly antialias: boolean;
  readonly alpha: boolean;
  readonly shadows: boolean;
  readonly toneMapping: 'none' | 'aces-filmic';
}

export interface ComponentDefinition<P extends JSONRecord = JSONRecord> {
  readonly key: string;
  readonly type: string;
  readonly enabled?: boolean;
  readonly properties?: P;
}

export interface SceneNodeDefinition {
  readonly localName: string;
  readonly parentLocalName: string | null;
  readonly transform?: DisplayTransform;
  readonly visible?: boolean;
  readonly label?: string | null;
  readonly components: readonly ComponentDefinition[];
}

export interface ScenePrefabInstanceDefinition {
  readonly localName: string;
  readonly parentLocalName: string | null;
  readonly prefabId: string;
  readonly transform?: DisplayTransform;
  readonly visible?: boolean;
  readonly state?: JSONRecord;
}

export interface SceneDefinitionInput {
  readonly schema: typeof SCENE_DEFINITION_SCHEMA;
  readonly id: string;
  readonly revision?: number;
  readonly sceneProfile: string;
  readonly rendererProfile: RendererProfile;
  readonly activeCameraLocalName: string;
  readonly nodes: readonly SceneNodeDefinition[];
  readonly prefabInstances: readonly ScenePrefabInstanceDefinition[];
}

export interface PrefabNodeDefinition {
  readonly localName?: string;
  readonly transform?: DisplayTransform;
  readonly visible?: boolean;
  readonly label?: string | null;
  readonly components: readonly ComponentDefinition[];
  readonly children: readonly PrefabNodeDefinition[];
}

export interface FixedPrefabInstanceDefinition {
  readonly key: string;
  readonly parentLocalPath: string | null;
  readonly prefabId: string;
  readonly transform?: DisplayTransform;
  readonly visible?: boolean;
  readonly state?: JSONRecord;
}

export interface PrefabSlotDefinition {
  readonly key: string;
  readonly parentLocalPath: string | null;
  readonly allowedPrefabIds: readonly string[];
  readonly maximumInstances: number;
}

export interface FixedPrefabInstanceState {
  readonly transform?: DisplayTransform;
  readonly visible?: boolean;
  readonly state?: JSONRecord;
}

export interface DynamicPrefabInstanceState {
  readonly prefabId: string;
  readonly transform?: DisplayTransform;
  readonly visible?: boolean;
  readonly state?: JSONRecord;
}

export interface PrefabStatePatch {
  readonly nodes?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly components?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly prefabInstances?: Readonly<Record<string, FixedPrefabInstanceState>>;
  readonly prefabSlots?: Readonly<Record<
    string,
    Readonly<Record<string, DynamicPrefabInstanceState>>
  >>;
}

export interface PrefabDefinitionInput {
  readonly schema: typeof PREFAB_DEFINITION_SCHEMA;
  readonly id: string;
  readonly revision?: number;
  readonly gameplayType: string;
  readonly root: PrefabNodeDefinition;
  readonly prefabInstances?: readonly FixedPrefabInstanceDefinition[];
  readonly prefabSlots?: readonly PrefabSlotDefinition[];
  readonly resolveState?: (
    state: JSONRecord,
    context: Readonly<Record<string, unknown>>,
  ) => PrefabStatePatch | null | undefined;
}

export interface ResourceDescriptor {
  readonly id: string;
  readonly kind: string;
  readonly revision?: number;
  readonly hash?: string;
  readonly [key: string]: unknown;
}

export interface Resource {
  readonly id: string;
  readonly schema: string;
  readonly revision: number;
  describe(): Readonly<ResourceDescriptor>;
}

export interface ResourceRegistrySnapshot {
  readonly schema: typeof RESOURCE_REGISTRY_SCHEMA;
  readonly resources: Readonly<Record<string, Readonly<ResourceDescriptor>>>;
}

export interface ResourceRegistry {
  readonly size: number;
  register(value: ResourceDescriptor): Resource;
  seal(): this;
  get(id: string): Resource | null;
  has(id: string): boolean;
  require(id: string): Resource;
  values(): IterableIterator<Resource>;
  validateReferences(): this;
  snapshot(): Readonly<ResourceRegistrySnapshot>;
}

export interface SceneRegistry {
  register(definition: SceneDefinition): SceneDefinition;
  seal(): this;
  get(id: string): SceneDefinition | null;
  require(id: string): SceneDefinition;
  values(): IterableIterator<SceneDefinition>;
}

export interface PrefabRegistry {
  register(definition: PrefabDefinition): PrefabDefinition;
  seal(): this;
  get(prefabId: string): PrefabDefinition | null;
  require(prefabId: string): PrefabDefinition;
  values(): IterableIterator<PrefabDefinition>;
}

export interface NodeView {
  readonly name: string;
  readonly label: string | null;
  readonly parentName: string | null;
  readonly childNames: readonly string[];
  readonly localTransform: DisplayTransform;
  readonly visibleSelf: boolean;
  readonly visibleInHierarchy: boolean;
  readonly componentKeys: readonly string[];
  getWorldTransform(out?: null): WorldTransform;
  getWorldTransform<T extends WorldTransformOutput>(out: T): T;
  getWorldTransform<T extends WorldTransformOutput>(out: T | null | undefined): T | WorldTransform;
  getComponentState(key: string): Readonly<Record<string, unknown>> | null;
}

export interface PublicNodeLookup {
  get(name: string): NodeView | null;
  require(name: string): NodeView;
  has(name: string): boolean;
}

export interface PublicDisplayContext {
  readonly scene: Readonly<{ name: string; activeCameraName: string | null }>;
  readonly nodes: PublicNodeLookup;
  getNode(name: string): NodeView | null;
  requireNode(name: string): NodeView;
  getWorldTransform(name: string, out?: null): false | WorldTransform;
  getWorldTransform<T extends WorldTransformOutput>(name: string, out: T): false | T;
  getWorldTransform<T extends WorldTransformOutput>(name: string, out: T | null | undefined): false | T | WorldTransform;
}

export interface DisplayFrame {
  readonly sourceTick: number;
  readonly visualSeconds: number;
  readonly deltaSeconds: number;
  readonly frameIndex: number;
  readonly display: PublicDisplayContext;
}

export interface ComponentOptions<P extends JSONRecord = JSONRecord> {
  readonly key: string;
  readonly enabled?: boolean;
  readonly properties?: P;
}

export class Component<P extends JSONRecord = JSONRecord> {
  static readonly typeId: string | null;
  static readonly allowMultiple: boolean;
  static readonly tickPhase: 'update' | 'before-render' | null;
  static readonly drivesTransform: boolean;
  constructor(options: ComponentOptions<P>);
  readonly key: string;
  readonly node: NodeView | null;
  readonly enabled: boolean;
  readonly disposed: boolean;
  readonly properties: Readonly<P>;
  readonly drivesTransform: boolean;
  setEnabled(enabled: boolean): void;
  setDrivenLocalTransform(transform: DisplayTransform): void;
  setAnimation(playerKey: string, animationId: string): void;
  playAnimation(playerKey: string, animationId: string): void;
  stopAnimation(playerKey: string): void;
  dispose(reason?: string): readonly unknown[];
  onAttach?(display: PublicDisplayContext): void;
  onDispose?(display: PublicDisplayContext, reason: string): void;
}

export class BehaviourComponent<P extends JSONRecord = JSONRecord> extends Component<P> {
  static readonly tickPhase: 'update' | 'before-render' | null;
  tick(frame: DisplayFrame): void;
}

export class RenderComponent<P extends JSONRecord = JSONRecord> extends Component<P> {
  static readonly allowMultiple: boolean;
}

export type ComponentConstructor<C extends Component = Component> = {
  new (options: ComponentOptions): C;
  readonly typeId: string;
  readonly allowMultiple: boolean;
  readonly tickPhase: 'update' | 'before-render' | null;
  readonly drivesTransform: boolean;
};

export interface ComponentDescriptor<C extends Component = Component> {
  readonly ComponentClass: ComponentConstructor<C>;
  readonly normalizeProperties?: (value: unknown, resourceRegistry?: ResourceRegistry | null) => JSONRecord;
  readonly resourceReferences?: (properties: JSONRecord) => readonly (string | {
    readonly id: string;
    readonly kinds: readonly string[];
  })[];
}

export interface CompiledComponentDefinition {
  readonly key: string;
  readonly type: string;
  readonly enabled: boolean;
  readonly properties: JSONRecord;
}

export interface ComponentRegistry {
  register(descriptor: ComponentDescriptor): this;
  seal(): this;
  has(typeId: string): boolean;
  catalogEntries(): readonly Readonly<Record<string, unknown>>[];
  require(typeId: string): ComponentDescriptor;
  compile(definition: ComponentDefinition, resourceRegistry?: ResourceRegistry | null): CompiledComponentDefinition;
  create(compiled: CompiledComponentDefinition): Component;
  patchComponentProperties(value: {
    readonly component: Component;
    readonly patch: JSONRecord;
    readonly resourceRegistry: ResourceRegistry;
  }): JSONRecord;
  normalizeProperties(typeId: string, value: unknown, resourceRegistry?: ResourceRegistry | null): JSONRecord;
  validateResourceReferences(typeId: string, properties: JSONRecord, resourceRegistry?: ResourceRegistry | null): readonly unknown[];
}

export class SceneDefinition {
  constructor(value: SceneDefinitionInput);
  readonly id: string;
  readonly schema: typeof SCENE_DEFINITION_SCHEMA;
  readonly revision: number;
  describe(): Readonly<Record<string, unknown>>;
  compile(registries: {
    readonly componentRegistry: ComponentRegistry;
    readonly resourceRegistry: ResourceRegistry;
    readonly prefabRegistry: PrefabRegistry;
  }): Readonly<Record<string, unknown>>;
}

export class PrefabDefinition {
  constructor(value: PrefabDefinitionInput);
  readonly id: string;
  readonly schema: typeof PREFAB_DEFINITION_SCHEMA;
  readonly revision: number;
  readonly gameplayType: string;
  describe(): Readonly<Record<string, unknown>>;
  compile(registries: {
    readonly componentRegistry: ComponentRegistry;
    readonly resourceRegistry: ResourceRegistry;
    readonly prefabRegistry?: PrefabRegistry;
  }): Readonly<Record<string, unknown>>;
  resolveState(state: JSONRecord, context?: Readonly<Record<string, unknown>>): PrefabStatePatch;
}

export interface AuthorityNodeRecord {
  readonly name: string;
  readonly parentName: string | null;
  readonly prefabId: string;
  readonly transformMode: 'initial' | 'live';
  readonly transform: DisplayTransform;
  readonly visible: boolean;
  readonly state: JSONRecord;
}

export interface AuthorityPort {
  createNode(command: AuthorityNodeRecord): string;
  setNodeTransform(command: { readonly name: string; readonly transform: DisplayTransform }): undefined;
  setNodeParent(command: { readonly name: string; readonly parentName: string | null }): undefined;
  setNodeVisible(command: { readonly name: string; readonly visible: boolean }): undefined;
  setNodeState(command: { readonly name: string; readonly state: JSONRecord }): undefined;
  replaceNodePrefab(command: { readonly name: string; readonly prefabId: string; readonly state: JSONRecord }): undefined;
  removeNode(command: { readonly name: string }): undefined;
}

export interface CommitGate {
  begin(cursor: DisplayCursor): undefined;
  seal(cursor: DisplayCursor): undefined;
  fail(error: unknown): undefined;
}

export interface DisplaySummary {
  readonly schema: typeof DISPLAY_SUMMARY_SCHEMA;
  readonly sceneName: string | null;
  readonly revision: number;
  readonly cursor: DisplayCursor;
  readonly nodeCount: number;
  readonly health: string;
}

export interface DisplayView {
  readonly nodeCount: number;
  readonly sceneName: string | null;
  readonly revision: number;
  readonly cursor: DisplayCursor;
  readonly health: string;
  getNode(name: string): NodeView | null;
  getWorldTransform(name: string, out?: null): false | WorldTransform;
  getWorldTransform<T extends WorldTransformOutput>(name: string, out: T): false | T;
  getWorldTransform<T extends WorldTransformOutput>(name: string, out: T | null | undefined): false | T | WorldTransform;
  getComponentState(name: string, componentKey: string): Readonly<Record<string, unknown>> | null;
  getAuthorityOwner(name: string): string | null;
  snapshot(): Readonly<Record<string, unknown>>;
}

export interface RenderPreparation {
  readonly requiresContinuousDraw?: boolean;
}

export interface PickHit {
  readonly nodeName: string;
  readonly componentKey: string;
  readonly point: Vec3;
  readonly distance: number;
}

export interface WorldPointProjection {
  readonly clientX: number;
  readonly clientY: number;
  readonly visible: boolean;
  readonly depth: number;
}

export interface WorldPointFocus {
  readonly nodeName: string;
  readonly componentKey: string;
  readonly position: Vec3;
  readonly target: Vec3;
}

export interface RenderBackendPort {
  createBinding(value: Readonly<Record<string, unknown>>): unknown | Promise<unknown>;
  updateBinding(binding: unknown, value: Readonly<Record<string, unknown>>): undefined;
  destroyBinding(binding: unknown): unknown | Promise<unknown>;
  prepareFrame(value: Readonly<Record<string, unknown>>): RenderPreparation | undefined;
  render(): undefined;
  requestResize(): unknown;
  pick(query: Readonly<{ clientX: number; clientY: number }>): PickHit | null;
  projectWorldPoint(point: Readonly<{ position: Vec3 }>): WorldPointProjection;
  focusWorldPoint(target: Readonly<{ position: Vec3; radius: number }>): WorldPointFocus;
  capture(): unknown;
  whenIdle(): Promise<void> | void;
  diagnostics(): unknown;
  dispose(): Promise<void> | void;
}

export interface FrameAdapter {
  request(callback: (time: number) => void): unknown;
  cancel(identity: unknown): void;
  now(): number;
}

export interface DisplayRuntimeOptions {
  readonly sceneRegistry: SceneRegistry;
  readonly prefabRegistry: PrefabRegistry;
  readonly resourceRegistry: ResourceRegistry;
  readonly componentRegistry: ComponentRegistry;
  readonly authorityStateSchemas: readonly AuthorityStateSchema[];
  readonly createRenderBackend: (options: Readonly<{
    hostElement: unknown;
    canvas: unknown;
    rendererProfile: RendererProfile;
    resourceRegistry: ResourceRegistry;
    signal: AbortSignal;
    onHealth: (event: Readonly<Record<string, unknown>>) => void;
  }>) => RenderBackendPort;
  readonly hostElement?: unknown;
  readonly canvas?: unknown;
  readonly frameAdapter?: FrameAdapter | null;
  readonly onHealth?: ((event: Readonly<Record<string, unknown>>) => void) | null;
}

export class DisplayRuntime {
  constructor(options: DisplayRuntimeOptions);
  readonly authority: Readonly<AuthorityPort>;
  readonly commitGate: Readonly<CommitGate>;
  installScene(value: { readonly sceneName: string }): this;
  catalogIdentity(): DisplayCatalogIdentity;
  activate(cursor?: DisplayCursor): undefined;
  start(): undefined;
  stop(): undefined;
  requestDraw(): undefined;
  whenReady(): Promise<void>;
  summary(): DisplaySummary;
  currentView(): DisplayView;
  pick(query: Readonly<{ clientX: number; clientY: number }>): PickHit | null;
  projectWorldPoint(point: Readonly<{ position: Vec3 }>): WorldPointProjection;
  focusWorldPoint(target: Readonly<{ position: Vec3; radius: number }>): WorldPointFocus;
  capture(): Readonly<Record<string, unknown>>;
  rebuildRenderBackend(): Promise<void>;
  dispose(): Promise<void>;
}

export class DisplayRuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message?: string, options?: ErrorOptions);
}

export class ModelRendererComponent extends RenderComponent { static readonly typeId: 'render.model@2'; }
export class MeshRendererComponent extends RenderComponent { static readonly typeId: 'render.mesh@1'; }
export class SpriteRendererComponent extends RenderComponent { static readonly typeId: 'render.sprite@3'; }
export class SurfaceRendererComponent extends RenderComponent { static readonly typeId: 'render.surface@1'; }
export class ParticleRendererComponent extends RenderComponent { static readonly typeId: 'render.particle@2'; }
export class CameraComponent extends RenderComponent { static readonly typeId: 'render.camera@1'; static readonly allowMultiple: false; }
export class BackgroundComponent extends RenderComponent { static readonly typeId: 'render.background@1'; static readonly allowMultiple: false; }
export class AmbientLightComponent extends RenderComponent { static readonly typeId: 'render.ambient-light@1'; }
export class DirectionalLightComponent extends RenderComponent { static readonly typeId: 'render.directional-light@1'; }
export class PointLightComponent extends RenderComponent { static readonly typeId: 'render.point-light@1'; }
export class SpotLightComponent extends RenderComponent { static readonly typeId: 'render.spot-light@1'; }
export class BillboardComponent extends BehaviourComponent { static readonly typeId: 'behavior.billboard@2'; static readonly tickPhase: 'before-render'; static readonly drivesTransform: true; }
export class LookAtComponent extends BehaviourComponent { static readonly typeId: 'behavior.look-at@1'; static readonly tickPhase: 'before-render'; static readonly drivesTransform: true; }

export const TICKS_PER_SECOND: 60;
export const DISPLAY_RUNTIME_SCHEMA: 'scene-engine-display-node@3';
export const DISPLAY_SUMMARY_SCHEMA: 'scene-engine-display-summary@1';
export const DISPLAY_CATALOG_MANIFEST_SCHEMA: 'scene-engine-display-catalog-manifest@1';
export const SCENE_DEFINITION_SCHEMA: 'scene-engine-scene-definition@1';
export const PREFAB_DEFINITION_SCHEMA: 'scene-engine-prefab-definition@3';
export const RESOURCE_REGISTRY_SCHEMA: 'scene-engine-resource-registry@1';
export const ANIMATION_RESOURCE_SCHEMA: 'scene-engine-animation-resource@2';

export interface AnimationTarget {
  readonly node: '$root' | string;
  readonly component: string;
}

export interface SpriteFrameKeyframe {
  readonly atMs: number;
  readonly value: number;
}

export interface SpriteFrameAnimationTrack {
  readonly channel: 'sprite.frame';
  readonly target: AnimationTarget;
  readonly interpolation: 'step';
  readonly keyframes: readonly SpriteFrameKeyframe[];
}

export interface AnimationResourceDescriptor {
  readonly id: string;
  readonly kind: 'animation';
  readonly schema: typeof ANIMATION_RESOURCE_SCHEMA;
  readonly revision?: number;
  readonly hash?: string;
  readonly durationMs: number;
  readonly loop: boolean;
  readonly tracks: readonly SpriteFrameAnimationTrack[];
}

export interface DefineAnimationInput {
  readonly id: string;
  readonly durationMs: number;
  readonly loop: boolean;
  readonly tracks: readonly SpriteFrameAnimationTrack[];
  readonly revision?: number;
  readonly hash?: string;
}

export interface DefineFrameAnimationInput {
  readonly id: string;
  readonly target: AnimationTarget;
  readonly frames: readonly number[];
  readonly fps: number;
  readonly loop: boolean;
  readonly revision?: number;
  readonly hash?: string;
}

export interface AnimationPlayerProperties {
  readonly animationId: string | null;
  readonly [key: string]: JSONValue;
}

export class AnimationPlayerComponent extends Component<AnimationPlayerProperties> {
  static readonly typeId: 'animation.player@1';
  static readonly allowMultiple: true;
}

export function defineAnimation(value: DefineAnimationInput): Readonly<AnimationResourceDescriptor>;
export function defineFrameAnimation(value: DefineFrameAnimationInput): Readonly<AnimationResourceDescriptor>;

export function defineDisplayCatalogManifest(value: DisplayCatalogManifest): DisplayCatalogManifest;
export function buildDisplayCatalogManifest(value: {
  readonly sceneRegistry: SceneRegistry;
  readonly prefabRegistry: PrefabRegistry;
  readonly resourceRegistry: ResourceRegistry;
  readonly componentRegistry: ComponentRegistry;
  readonly authorityStateSchemas: readonly AuthorityStateSchema[];
}): DisplayCatalogManifest;
export function canonicalDisplayCatalogJson(value: unknown): string;
export function computeDisplayCatalogIdentity(value: DisplayCatalogManifest): DisplayCatalogIdentity;
export function normalizeDisplayCatalogIdentity(value: DisplayCatalogIdentity): DisplayCatalogIdentity;
export function sameDisplayCatalogIdentity(left: DisplayCatalogIdentity, right: DisplayCatalogIdentity): boolean;
export function toDisplayCatalogIdentityRecord(value: DisplayCatalogIdentity): DisplayCatalogIdentityRecord;

export function defineScene(value: SceneDefinitionInput): SceneDefinition;
export function definePrefab(value: PrefabDefinitionInput): PrefabDefinition;
export function defineResources(value: {
  readonly schema: typeof RESOURCE_REGISTRY_SCHEMA;
  readonly resources: readonly ResourceDescriptor[];
}): Readonly<Record<string, unknown>>;
export function createSceneRegistry(initial?: readonly SceneDefinition[]): SceneRegistry;
export function createPrefabRegistry(initial?: readonly PrefabDefinition[]): PrefabRegistry;
export function createResourceRegistry(initial?: readonly ResourceDescriptor[] | Readonly<Record<string, unknown>>): ResourceRegistry;
export function createComponentRegistry(options?: { readonly includeBuiltIns?: boolean }): ComponentRegistry;
export function createDisplayRuntime(options: DisplayRuntimeOptions): DisplayRuntime;
