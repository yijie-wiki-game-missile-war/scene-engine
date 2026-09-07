export type Vec3 = readonly [number, number, number];

export interface RendererProfile {
  readonly drawMode: 'requested' | 'continuous';
  readonly maximumPixelRatio: number;
  readonly clearRgba: number;
  readonly antialias: boolean;
  readonly alpha: boolean;
  readonly shadows: boolean;
  readonly toneMapping: 'none' | 'aces-filmic';
}

export interface RenderCompositionPlan {
  readonly schema: 'scene-engine-render-composition@1';
  readonly id: string;
  readonly revision: number;
  readonly defaultGroup: string;
  readonly groups: readonly Readonly<{ id: string }>[];
  readonly passes: readonly Readonly<{
    id: string;
    kind: 'protected-base' | 'ordinary' | 'foreground';
    groups: readonly string[];
  }>[];
}

export interface ThreeRenderBackendOptions {
  readonly generatedTextureSource?: import('@scene-engine/display').GeneratedTextureSourcePort | null;
  readonly hostElement: unknown;
  readonly canvas: unknown;
  readonly rendererProfile: RendererProfile;
  readonly compositionPlan: RenderCompositionPlan | null;
  readonly resourceRegistry: {
    require(id: string): unknown;
    get?(id: string): unknown;
    has?(id: string): boolean;
  };
  readonly onHealth?: ((event: import('@scene-engine/display').RenderHealthEvent) => void) | null;
  readonly signal?: AbortSignal;
}

export interface PickHit {
  readonly nodeName: string;
  readonly componentKey: string;
  readonly point: Vec3;
  readonly distance: number;
}

export interface WorldRay {
  readonly origin: Vec3;
  readonly direction: Vec3;
}

export interface ProximityHit {
  readonly nodeName: string;
  readonly componentKey: string;
  readonly screenDistancePixels: number;
  readonly depth: number;
}

export type WorldPointProjection = Readonly<{
  clientX: number; clientY: number; visible: boolean; depth: number;
}> | Readonly<{ clientX: null; clientY: null; visible: false; depth: null }>;

export interface WorldPointFocus {
  readonly nodeName: string;
  readonly componentKey: string;
  readonly position: Vec3;
  readonly target: Vec3;
}

export interface ThreeRenderBackendPort {
  createBinding(value: Readonly<Record<string, unknown>>): unknown | Promise<unknown>;
  updateBinding(binding: unknown, value: Readonly<Record<string, unknown>>): undefined;
  destroyBinding(binding: unknown): unknown | Promise<unknown>;
  prepareFrame(value: Readonly<Record<string, unknown>>): Readonly<{
    readonly requiresContinuousDraw: boolean;
  }>;
  render(): undefined;
  requestResize(): unknown;
  pick(value: Readonly<{ clientX: number; clientY: number }>): PickHit | null;
  screenPointToWorldRay(value: Readonly<{
    clientX: number;
    clientY: number;
  }>): WorldRay;
  pickProximity(value: Readonly<{
    clientX: number;
    clientY: number;
    radiusPixels: number;
  }>): ProximityHit | null;
  projectWorldPoint(value: Readonly<{ position: Vec3 }>): WorldPointProjection;
  focusWorldPoint(value: Readonly<{ position: Vec3; radius: number; halfExtents?: never } | { position: Vec3; halfExtents: Vec3; radius?: never }>): WorldPointFocus;
  capture(): unknown;
  whenIdle(): Promise<void> | void;
  diagnostics(): unknown;
  dispose(): Promise<void> | void;
}

export const THREE_RENDER_BACKEND_SCHEMA: 'scene-engine-three-render-backend@4';

export class ThreeRenderBackendError extends Error {
  readonly code: string;
  constructor(code: string, message?: string, options?: ErrorOptions);
}

export function createThreeRenderBackend(options: ThreeRenderBackendOptions): Readonly<ThreeRenderBackendPort>;
