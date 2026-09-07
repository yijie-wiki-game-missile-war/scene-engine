import * as THREE from 'three';
import { fail } from './errors.js';

export function createGeneratedTexture(descriptor, signal, context) {
  const source = context?.generatedTextureSource;
  const renderer = context?.renderer;
  const gl = renderer?.getContext?.();
  if (!source || !renderer?.initTexture || !gl?.fenceSync || !gl?.clientWaitSync
      || descriptor.width > renderer.capabilities.maxTextureSize || descriptor.height > renderer.capabilities.maxTextureSize)
    fail('three-generated-texture-device-unsupported');
  if (descriptor.format === 'rgba32float' && descriptor.filter === 'linear'
      && renderer.extensions?.has?.('OES_texture_float_linear') !== true) fail('three-generated-texture-filter-unsupported');
  const lease = source.acquire(descriptor.id);
  try {
    const Type = descriptor.format === 'rgba32float' ? Float32Array : Uint8Array;
    let data = new Type(descriptor.width * descriptor.height * 4);
    const texture = new THREE.DataTexture(data, descriptor.width, descriptor.height, THREE.RGBAFormat,
      descriptor.format === 'rgba32float' ? THREE.FloatType : THREE.UnsignedByteType);
    texture.colorSpace = THREE.NoColorSpace; texture.flipY = false; texture.generateMipmaps = false;
    texture.premultiplyAlpha = false; texture.unpackAlignment = 1;
    texture.minFilter = texture.magFilter = descriptor.filter === 'linear' ? THREE.LinearFilter : THREE.NearestFilter;
    texture.wrapS = texture.wrapT = descriptor.wrap === 'repeat' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    let disposed = false, fence = null, fenceGeneration = -1, initialized = false, fencePolls = 0;
    const asset = {
      kind: 'generated-texture', descriptor, texture, ownsTexture: true,
      get generatedInitialized() { return initialized; },
      prepareGeneratedTexture(budget) {
        if (disposed) return { pending: false, uploadedBytes: 0 };
        if (fence) {
          const status = gl.clientWaitSync(fence, 0, 0);
          if (status === gl.WAIT_FAILED) fail('three-generated-texture-upload-failed');
          if (status === gl.TIMEOUT_EXPIRED) {
            if (++fencePolls > 120) fail('three-generated-texture-fence-timeout');
            return { pending: true, uploadedBytes: 0 };
          }
          gl.deleteSync(fence); fence = null; lease.uploaded(fenceGeneration);
        }
        const update = lease.update(budget);
        if (!update) return { pending: false, uploadedBytes: 0 };
        if (update.deferred) return { pending: true, uploadedBytes: 0 };
        for (const region of update.regions) {
          data.set(region.data, region.start);
          if (initialized) texture.addUpdateRange(region.start, region.count);
        }
        texture.needsUpdate = true;
        renderer.initTexture(texture);
        if (gl.getError() !== gl.NO_ERROR) fail('three-generated-texture-upload-failed');
        fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (!fence) fail('three-generated-texture-upload-failed');
        gl.flush(); fenceGeneration = update.generation; fencePolls = 0; initialized = true;
        lease.submitted(update.generation);
        return { pending: true, uploadedBytes: update.byteLength };
      },
      disposeGeneratedTexture() {
        if (disposed) return; disposed = true;
        if (fence) { gl.deleteSync(fence); fence = null; }
        texture.dispose(); texture.image.data = null; data = null;
        lease.release(signal?.reason ?? 'resource-unreferenced');
      },
    };
    return asset;
  } catch (error) { lease.release('resource-load-failed'); throw error; }
}
