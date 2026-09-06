import {
  BehaviourComponent, createDisplayRuntime, createResourceRegistry,
  type DisplayRuntime, type GeneratedTextureResourceDescriptor, type GeneratedTextureTicket,
  type GeneratedTextureSourcePort, type SpriteProjectionProperties, type TextureResourceDescriptor,
  type ProgramParameterValue, type DisplayRuntimeOptions, type SpriteProperties,
} from '@scene-engine/display';
import { createThreeRenderBackend, type ThreeRenderBackendOptions } from '@scene-engine/renderer-three';
import * as client from '@scene-engine/client';

const anchor: SpriteProjectionProperties = { projectionSemantics: 'anchor-extent', anchorOffset: [1, 2, 3] };
const programSprite: SpriteProperties = { materialResourceId: 'program/material', width: 2, height: 1,
  projectionSemantics: 'anchor-extent', anchorOffset: [0, 1, 0], pivot: [.5, .2], parameters: { amount: .5 } };
// @ts-expect-error A program sprite has exactly one resource branch.
const mixedSprite: SpriteProperties = { ...programSprite, textureResourceId: 'image' };
// @ts-expect-error Program sprites require anchor-extent.
const geometryProgram: SpriteProperties = { materialResourceId: 'program/material', width: 1, height: 1, projectionSemantics: 'geometry' };
const geometry: SpriteProjectionProperties = { projectionSemantics: 'geometry' };
// @ts-expect-error Geometry does not define anchor offsets.
const badAnchor: SpriteProjectionProperties = { projectionSemantics: 'geometry', anchorOffset: [0, 0, 0] };
const texture: TextureResourceDescriptor = { id: 'color', kind: 'texture', url: './color.png', colorSpace: 'srgb',
  minFilter: 'linear-mipmap-linear', magFilter: 'linear', mipmaps: true,
  alphaEncoding: 'straight', alphaSampling: 'premultiplied', wrap: { s: 'repeat', t: 'clamp' } };
// @ts-expect-error Magnification cannot select mipmaps.
const badTexture: TextureResourceDescriptor = { id: 'bad', kind: 'texture', url: './x.png', magFilter: 'linear-mipmap-linear' };
const data: GeneratedTextureResourceDescriptor = { id: 'field', kind: 'generated-texture', revision: 1,
  width: 2, height: 2, format: 'rgba8unorm', usage: 'data', initialValue: [0, 0, 0, 255],
  budget: { maxUpdateBytes: 16, maxRegions: 2 } };
createResourceRegistry([texture, data]);
class Writer extends BehaviourComponent {
  tick() {
    const values: Record<string, ProgramParameterValue> = { amount: .5, color: [1, 0, 0], enabled: true };
    this.setProgramParameters('program', values);
    this.setProgramParameters('program', null);
    // @ts-expect-error Program parameters are typed values, never arbitrary objects.
    this.setProgramParameters('program', { invalid: { private: true } });
  }
}
function exercise(runtime: DisplayRuntime, source: GeneratedTextureSourcePort, options: DisplayRuntimeOptions,
  rendererOptions: ThreeRenderBackendOptions) {
  const ticket: GeneratedTextureTicket = runtime.generatedTextures.begin('field', { sourceRevision: 'checkpoint@1' });
  ticket.commit({ regions: [{ x: 0, y: 0, width: 1, height: 1, data: new Uint8Array(4) }] });
  ticket.cancel();
  runtime.generatedTextures.whenReady('field');
  runtime.generatedTextures.status('field').committedSourceRevision;
  runtime.setVisualTimePaused(true);
  runtime.setVisualTimePaused(false);
  runtime.rebuildRenderBackend();
  source.acquire('field').release();
  createDisplayRuntime(options);
  createThreeRenderBackend({ ...rendererOptions, generatedTextureSource: source });
  // @ts-expect-error Generated updates require typed pixel storage.
  ticket.commit({ regions: [{ x: 0, y: 0, width: 1, height: 1, data: [0, 0, 0, 0] }] });
}
void [client, programSprite, mixedSprite, geometryProgram, anchor, geometry, Writer, exercise, badAnchor, badTexture];
