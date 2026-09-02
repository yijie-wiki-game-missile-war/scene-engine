export type JSONPrimitive = null | boolean | number | string;
export type JSONValue = JSONPrimitive | readonly JSONValue[] | { readonly [key: string]: JSONValue };
export type JSONRecord = { readonly [key: string]: JSONValue };
export type ByteSource = ArrayBuffer | ArrayBufferView;
export type Vec3 = readonly [number, number, number];
export type Matrix4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];
export type Matrix4Input = Matrix4 | Float32Array;
export type DisplayTransform = Matrix4;
export type WorldTransform = Matrix4;

export interface MutableNumericArray {
  readonly length: number;
  [index: number]: number;
}

export type WorldTransformOutput = MutableNumericArray;

export interface EngineLimits {
  readonly maximumPacketBytes: number;
  readonly maximumHeaderBytes: number;
  readonly maximumAttachmentCount: number;
  readonly maximumAttachmentBytes: number;
  readonly maximumWorldPatchChanges: number;
  readonly maximumJsonPathSegments: number;
  readonly maximumJsonDepth: number;
  readonly maximumPendingInputsPerClient: number;
  readonly maximumInFlightCommits: number;
  readonly maximumSessionPendingBytes: number;
  readonly maximumGlobalRetainedPackets: number;
  readonly maximumGlobalRetainedBytes: number;
  readonly ackTimeoutTicks: number;
}

export interface CommitView {
  readonly kind: 'checkpoint' | 'commit';
  readonly streamId: string;
  readonly commitSeq: number;
  readonly sourceTick: number;
  readonly worldRevision: number;
  readonly lastCommandSeq: number;
  readonly cause: string | null;
  readonly causationId: string | null;
}

export interface DisplayCursor {
  readonly commitSeq: number;
  readonly sourceTick: number;
  readonly lastCommandSeq: number;
}

export interface DisplaySummary {
  readonly schema: 'scene-engine-display-summary@1';
  readonly sceneName: string | null;
  readonly revision: number;
  readonly cursor: DisplayCursor;
  readonly nodeCount: number;
  readonly health: string;
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

export interface DisplaySessionMetadata {
  readonly sceneName: string;
  readonly commit: CommitView;
}

export interface DisplaySessionRuntime {
  installScene(value: { readonly sceneName: string }): DisplaySessionRuntime;
  activate(cursor: DisplayCursor): undefined;
  start(): undefined;
  summary(): DisplaySummary;
  currentView(): DisplayView;
}

export interface AuthorityNodeRecord {
  readonly nodeId: number;
  readonly parentNodeId: number | null;
  readonly displayKindId: string;
  readonly transformMode: 'initial' | 'live';
  readonly visible: boolean;
  readonly state: JSONRecord;
}

export interface NodeMatrixPoolRecord {
  readonly poolSize: number;
  readonly matrices: Float32Array;
}

export interface NodeTransformBatchRecord extends NodeMatrixPoolRecord {
  readonly nodeIds: Uint32Array;
}

export interface NodeTransformTargetsRecord {
  readonly nodeIds: Uint32Array;
}

export interface DisplayAuthorityPort {
  installNodeMatrixPool(command: NodeMatrixPoolRecord): undefined;
  applyNodeTransformBatch(command: NodeTransformBatchRecord): undefined;
  setNodeTransforms(command: NodeTransformTargetsRecord): undefined;
  createNode(command: AuthorityNodeRecord): number;
  setNodeParent(command: { readonly nodeId: number; readonly parentNodeId: number | null }): undefined;
  setNodeVisible(command: { readonly nodeId: number; readonly visible: boolean }): undefined;
  setNodeState(command: { readonly nodeId: number; readonly state: JSONRecord }): undefined;
  setNodeProperty(command: {
    readonly nodeId: number;
    readonly propertyName: string;
    readonly value: JSONValue;
  }): undefined;
  unsetNodeProperty(command: { readonly nodeId: number; readonly propertyName: string }): undefined;
  emitNodeEvent(command: {
    readonly nodeId: number;
    readonly eventName: string;
    readonly payload: JSONRecord;
    readonly commandSeq: number;
    readonly sourceTick: number;
  }): undefined;
  setNodeDisplayKind(command: {
    readonly nodeId: number;
    readonly displayKindId: string;
    readonly state: JSONRecord;
  }): undefined;
  removeNode(command: { readonly nodeId: number }): undefined;
}

export interface DisplayCommitGate {
  begin(cursor: DisplayCursor): undefined;
  seal(cursor: DisplayCursor): undefined;
  fail(error: unknown): void | PromiseLike<unknown>;
}

export interface DisplaySession {
  readonly runtime: DisplaySessionRuntime;
  readonly authorityPort: DisplayAuthorityPort;
  readonly commitGate: DisplayCommitGate;
  dispose(): void | PromiseLike<unknown>;
  readonly [key: string]: unknown;
}

export interface CommitObserverPayload {
  readonly kind: 'checkpoint' | 'commit';
  readonly commit: CommitView;
  readonly worldState: JSONValue;
  readonly displaySummary: DisplaySummary;
}

export interface InputResult {
  readonly inputId: string;
  readonly status: string;
  readonly reasonCode: string | null;
  readonly result: JSONValue | null;
}

export interface ApplyPacketOutcome {
  readonly kind: 'checkpoint' | 'commit' | 'input_result';
  readonly commit: CommitView | null;
  readonly ackPacket: Uint8Array | null;
  readonly inputResult: InputResult | null;
}

export interface SceneEngineClientOptions {
  readonly limits?: Partial<EngineLimits>;
  readonly onCommit?: ((payload: CommitObserverPayload) => void) | null;
  readonly createDisplaySession: (metadata: DisplaySessionMetadata) => DisplaySession;
}

export class SceneEngineClientError extends Error {
  readonly code: string;
  constructor(code: string, message?: string, options?: ErrorOptions);
}

export class SceneEngineClient {
  constructor(options: SceneEngineClientOptions);
  applyPacket(rawBytes: ByteSource): ApplyPacketOutcome;
  currentWorldState(): JSONValue | null;
  currentCommit(): CommitView | null;
  currentDisplayView(): DisplayView | null;
  encodeInput(value: {
    readonly inputId: string;
    readonly command: string;
    readonly args?: JSONRecord;
  }): Uint8Array;
  capture(): Readonly<{
    commit: CommitView | null;
    worldState: JSONValue | null;
    displayView: DisplayView | null;
  }>;
  dispose(): undefined;
}

export const DEFAULT_ENGINE_LIMITS: Readonly<EngineLimits>;

export function encodeEngineInput(value: {
  readonly inputId: string;
  readonly observedStreamId: string;
  readonly observedCommitSeq: number;
  readonly command: string;
  readonly args?: JSONRecord;
}, limits?: Partial<EngineLimits>): Uint8Array;

export function encodeEngineAck(value: {
  readonly streamId: string;
  readonly commitSeq: number;
  readonly lastCommandSeq: number;
}, limits?: Partial<EngineLimits>): Uint8Array;

export function readEnginePacket(value: ByteSource, limits?: Partial<EngineLimits>): Readonly<Record<string, unknown>>;

export function readPacketLog(value: {
  readonly manifest: ByteSource;
  readonly index: ByteSource;
  readonly packets: ByteSource;
}, limits?: Partial<EngineLimits>): Readonly<{
  manifest: Readonly<Record<string, unknown>>;
  entries: readonly Readonly<Record<string, unknown>>[];
  records: readonly Readonly<Record<string, unknown>>[];
  packetAt(recordIndex: number): Uint8Array;
}>;
