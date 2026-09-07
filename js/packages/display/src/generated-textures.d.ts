export interface GeneratedTextureResourceDescriptor {
  readonly [key: string]: unknown;
  readonly id: string; readonly kind: 'generated-texture';
  readonly schema?: 'scene-engine-generated-texture-resource@1'; readonly revision: number;
  readonly width: number; readonly height: number;
  readonly format: 'rgba8unorm' | 'rgba32float'; readonly usage: 'data';
  readonly initialValue: readonly [number, number, number, number];
  readonly filter?: 'nearest' | 'linear'; readonly wrap?: 'clamp' | 'repeat';
  readonly budget: Readonly<{ maxUpdateBytes: number; maxRegions: number }>;
}
export interface GeneratedTextureRegion {
  readonly x: number; readonly y: number; readonly width: number; readonly height: number;
  readonly data: Uint8Array | Float32Array;
}
export interface GeneratedTextureStatus {
  readonly resourceId: string; readonly generation: number; readonly sourceRevision: string | null;
  readonly committedGeneration: number; readonly committedSourceRevision: string | null;
  readonly status: 'generating' | 'pending-upload' | 'ready' | 'cancelled' | 'failed';
  readonly errorCode: string | null;
  readonly sampleable: boolean; readonly byteLength: number;
}
export interface GeneratedTextureTicket {
  readonly generation: number; readonly sourceRevision: string; readonly signal: AbortSignal;
  commit(value: Readonly<{ regions: readonly GeneratedTextureRegion[] }>): Readonly<{ status: 'staged' | 'discarded'; generation: number }>;
  cancel(): boolean;
}
export interface GeneratedTextures {
  begin(resourceId: string, value: Readonly<{ sourceRevision: string }>): GeneratedTextureTicket;
  status(resourceId: string): GeneratedTextureStatus;
  whenReady(resourceId: string): Promise<GeneratedTextureStatus | Readonly<{ status: 'discarded' | 'disposed'; generation: number }>>;
}
/** Renderer factory capability; copied CPU pixels, never GPU objects. */
export interface GeneratedTextureSourcePort {
  failed(resourceId: string, errorCode: string): void;
  acquire(resourceId: string): {
    update(budget?: number): { deferred: true; byteLength: number } | {
      generation: number; sourceRevision: string | null; byteLength: number;
      regions: readonly { start: number; count: number; data: Uint8Array | Float32Array }[];
    } | null;
    submitted(generation: number): void; uploaded(generation: number): void; release(reason?: unknown): void;
  };
}
export const GENERATED_TEXTURE_RESOURCE_SCHEMA: 'scene-engine-generated-texture-resource@1';
export const GENERATED_TEXTURE_LIMITS: Readonly<{
  maximumDimension: number; maximumTextureBytes: number; maximumTotalTextureBytes: number;
  maximumResources: number; maximumRegions: number; maximumUploadBytesPerFrame: number;
}>;
