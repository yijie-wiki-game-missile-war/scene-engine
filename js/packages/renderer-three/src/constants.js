export const THREE_RENDER_BACKEND_SCHEMA = 'scene-engine-three-render-backend@4';

export const RENDER_COMPOSITION_SCHEMA = 'scene-engine-render-composition@1';

export const COMPOSED_COMPONENT_TYPES = Object.freeze(new Set([
  'render.model@2',
  'render.mesh@1',
  'render.sprite@3',
  'render.surface@1',
  'render.particle@2',
]));

export const TICKS_PER_SECOND = 60;

export const COMPONENT_TYPES = Object.freeze(new Set([
  'render.model@2',
  'render.mesh@1',
  'render.sprite@3',
  'render.surface@1',
  'render.particle@2',
  'render.camera@1',
  'render.background@1',
  'render.ambient-light@1',
  'render.directional-light@1',
  'render.point-light@1',
  'render.spot-light@1',
]));
