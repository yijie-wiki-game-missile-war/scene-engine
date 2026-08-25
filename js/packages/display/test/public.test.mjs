import assert from 'node:assert/strict';
import test from 'node:test';

import * as api from '@scene-engine/display';

test('0.2 root is the exact Display public surface and excludes LocalEdit', () => {
  assert.deepEqual(Object.keys(api).sort(), [
    'AmbientLightComponent',
    'AuthorityComponent',
    'BackgroundComponent',
    'BehaviourComponent',
    'BillboardComponent',
    'CameraComponent',
    'Component',
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
    'createComponentRegistry',
    'createDisplayRuntime',
    'createPrefabRegistry',
    'createResourceRegistry',
    'createSceneRegistry',
    'definePrefab',
    'defineResources',
    'defineScene',
  ]);

  for (const removed of [
    ['Local', 'Edit', 'Port'].join(''),
    ['create', 'Local', 'Edit', 'Port'].join(''),
  ]) assert.equal(removed in api, false, removed);
});
