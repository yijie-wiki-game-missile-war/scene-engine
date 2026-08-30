import { Component } from '../component/component.js';
import { exactKeys, nonemptyString } from '../internal.js';
import { fail } from '../runtime/health.js';

const PROPERTY_ERROR = 'display-component-properties-invalid';

/**
 * Display-local animation player. One component instance owns at most one playing
 * animation and must live on a Prefab root; all timing and sampling state belongs to
 * the AnimationSystem, never to this component.
 */
export class AnimationPlayerComponent extends Component {
  static typeId = 'animation.player@1';
  static allowMultiple = true;
}

export function normalizeAnimationPlayerProperties(value) {
  const record = exactKeys(value, [], ['animationId'], PROPERTY_ERROR);
  const animationId = record.animationId == null ? null
    : nonemptyString(record.animationId, PROPERTY_ERROR);
  return Object.freeze({ animationId });
}

export const ANIMATION_PLAYER_COMPONENT_DESCRIPTOR = Object.freeze({
  ComponentClass: AnimationPlayerComponent,
  normalizeProperties: normalizeAnimationPlayerProperties,
  resourceReferences: (properties) => properties.animationId === null
    ? [] : [{ id: properties.animationId, kinds: ['animation'] }],
});
