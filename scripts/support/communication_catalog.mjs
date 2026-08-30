#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import {
  PREFAB_DEFINITION_SCHEMA,
  SCENE_DEFINITION_SCHEMA,
  buildDisplayCatalogManifest,
  computeDisplayCatalogIdentity,
  createComponentRegistry,
  createPrefabRegistry,
  createResourceRegistry,
  createSceneRegistry,
  definePrefab,
  defineScene,
  toDisplayCatalogIdentityRecord,
} from '../../js/packages/display/src/index.js';
import { IDENTITY_MATRIX } from './matrix4.mjs';

export const COMMUNICATION_SCENE_ID = 'communication';
export const COMMUNICATION_PREFAB_ID = 'communication/root';
export const COMMUNICATION_GAMEPLAY_TYPE = 'communication.root';
export const COMMUNICATION_AUTHORITY_STATE_SCHEMAS = Object.freeze([Object.freeze({
  gameplayType: COMMUNICATION_GAMEPLAY_TYPE,
  schemaId: 'communication.root.state@1',
  revision: 1,
})]);

const RENDERER_PROFILE = Object.freeze({
  drawMode: 'requested',
  maximumPixelRatio: 1,
  clearRgba: 0x000000ff,
  antialias: false,
  alpha: false,
  shadows: false,
  toneMapping: 'none',
});

export function communicationPrefab() {
  return definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: COMMUNICATION_PREFAB_ID,
    gameplayType: COMMUNICATION_GAMEPLAY_TYPE,
    root: { components: [], children: [] },
  });
}

export function communicationScene() {
  return defineScene({
    schema: SCENE_DEFINITION_SCHEMA,
    id: COMMUNICATION_SCENE_ID,
    sceneProfile: 'communication.no-render',
    rendererProfile: RENDERER_PROFILE,
    activeCameraLocalName: 'camera',
    nodes: [{
      localName: 'camera',
      parentLocalName: null,
      transform: IDENTITY_MATRIX,
      components: [{
        key: 'camera',
        type: 'render.camera@1',
        properties: {
          projection: 'perspective',
          fovYDegrees: 50,
          near: 0.1,
          far: 1_000,
        },
      }],
    }],
    prefabInstances: [],
  });
}

export function buildCommunicationCatalog() {
  const sceneRegistry = createSceneRegistry([communicationScene()]);
  const prefabRegistry = createPrefabRegistry([communicationPrefab()]);
  const resourceRegistry = createResourceRegistry();
  const componentRegistry = createComponentRegistry();
  const manifest = buildDisplayCatalogManifest({
    sceneRegistry,
    prefabRegistry,
    resourceRegistry,
    componentRegistry,
    authorityStateSchemas: COMMUNICATION_AUTHORITY_STATE_SCHEMAS,
  });
  return {
    sceneRegistry,
    prefabRegistry,
    resourceRegistry,
    componentRegistry,
    manifest,
    identity: computeDisplayCatalogIdentity(manifest),
  };
}

function main() {
  const { identity } = buildCommunicationCatalog();
  process.stdout.write(`${JSON.stringify(toDisplayCatalogIdentityRecord(identity))}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
