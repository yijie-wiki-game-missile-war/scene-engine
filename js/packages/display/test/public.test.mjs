import assert from 'node:assert/strict';
import test from 'node:test';

import * as api from '@scene-engine/display';

test('0.8 root is the exact Display public surface and excludes internal Authority mutation types', () => {
  assert.deepEqual(Object.keys(api).sort(), [
    'ANIMATION_RESOURCE_SCHEMA',
    'AmbientLightComponent',
    'AnimationPlayerComponent',
    'BackgroundComponent',
    'BehaviourComponent',
    'BillboardComponent',
    'CameraComponent',
    'Component',
    'DISPLAY_CATALOG_MANIFEST_SCHEMA',
    'DISPLAY_RUNTIME_SCHEMA',
    'DISPLAY_SUMMARY_SCHEMA',
    'DirectionalLightComponent',
    'DisplayRuntime',
    'DisplayRuntimeError',
    'LookAtComponent',
    'MeshRendererComponent',
    'ModelRendererComponent',
    'PREFAB_DEFINITION_SCHEMA',
    'ParticleRendererComponent',
    'PointLightComponent',
    'PrefabDefinition',
    'RESOURCE_REGISTRY_SCHEMA',
    'RenderComponent',
    'SCENE_DEFINITION_SCHEMA',
    'SceneDefinition',
    'SpotLightComponent',
    'SpriteRendererComponent',
    'SurfaceRendererComponent',
    'TICKS_PER_SECOND',
    'buildDisplayCatalogManifest',
    'canonicalDisplayCatalogJson',
    'computeDisplayCatalogIdentity',
    'createComponentRegistry',
    'createDisplayRuntime',
    'createPrefabRegistry',
    'createResourceRegistry',
    'createSceneRegistry',
    'defineAnimation',
    'defineDisplayCatalogManifest',
    'defineFrameAnimation',
    'definePrefab',
    'defineResources',
    'defineScene',
    'normalizeDisplayCatalogIdentity',
    'sameDisplayCatalogIdentity',
    'toDisplayCatalogIdentityRecord',
  ]);

  for (const removed of [
    ['Local', 'Edit', 'Port'].join(''),
    ['create', 'Local', 'Edit', 'Port'].join(''),
    'AnimationSystem',
  ]) assert.equal(removed in api, false, removed);
});
