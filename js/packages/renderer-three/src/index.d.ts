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

export interface ThreeRenderBackendOptions {
  readonly hostElement: unknown;
  readonly canvas: unknown;
  readonly rendererProfile: RendererProfile;
  readonly resourceRegistry: {
    require(id: string): unknown;
    get?(id: string): unknown;
    has?(id: string): boolean;
  };
  readonly onHealth?: ((event: Readonly<Record<string, unknown>>) => void) | null;
  readonly signal?: AbortSignal;
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
  projectWorldPoint(value: Readonly<{ position: Vec3 }>): WorldPointProjection;
  focusWorldPoint(value: Readonly<{ position: Vec3; radius: number }>): WorldPointFocus;
  capture(): unknown;
  whenIdle(): Promise<void> | void;
  diagnostics(): unknown;
  dispose(): Promise<void> | void;
}

export const THREE_RENDER_BACKEND_SCHEMA: 'scene-engine-three-render-backend@3';

export class ThreeRenderBackendError extends Error {
  readonly code: string;
  constructor(code: string, message?: string, options?: ErrorOptions);
}

export function createThreeRenderBackend(options: ThreeRenderBackendOptions): Readonly<ThreeRenderBackendPort>;
