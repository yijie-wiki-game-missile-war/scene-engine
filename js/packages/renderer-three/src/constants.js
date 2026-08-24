export const THREE_RENDER_RUNTIME_SCHEMA = 'scene-engine-three-render-runtime@2';
export const RENDER_COMPOSITION_SCHEMA = 'scene-engine-render-composition@2';
export const RENDER_SNAPSHOT_SCHEMA = 'scene-engine-render-snapshot@2';
export const RENDER_BATCH_SCHEMA = 'scene-engine-render-batch@2';
export const RENDER_RESOURCE_CATALOG_SCHEMA = 'scene-engine-render-resource-catalog@2';

export const PIPELINE_IDS = Object.freeze([
  'model@2',
  'sprite@2',
  'surface@2',
  'particle@2',
  'scene-pass@2',
]);

export const LAYER_SCOPE_NODE_COMPOSITION = 'node-composition';
export const LAYER_SCOPE_SCENE_LAYERS = 'scene-layers';

export const NODE_VISIBLE = 1;
export const MAXIMUM_PENDING_JOBS = 20_000;
