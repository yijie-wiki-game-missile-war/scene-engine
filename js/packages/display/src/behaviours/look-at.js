import { BehaviourComponent } from '../component/behaviour-component.js';
import { enumValue, exactKeys, tuple } from '../internal.js';
import { quaternionFromForward } from '../math/quaternion.js';
import { localDirectionForWorldFacing } from '../math/transform.js';
import { assertNodeName } from '../node/node-name.js';
import { fail } from '../runtime/health.js';

export function normalizeLookAtProperties(value) {
  const record = exactKeys(value, [], ['targetNodeName', 'targetPosition', 'axisMode'],
    'display-component-properties-invalid');
  const hasNode = Object.hasOwn(record, 'targetNodeName') && record.targetNodeName !== null;
  const hasPosition = Object.hasOwn(record, 'targetPosition') && record.targetPosition !== null;
  if (hasNode === hasPosition) fail('display-component-properties-invalid');
  return {
    targetNodeName: hasNode ? assertNodeName(record.targetNodeName) : null,
    targetPosition: hasPosition ? Object.freeze(tuple(record.targetPosition, 3,
      'display-component-properties-invalid')) : null,
    axisMode: Object.hasOwn(record, 'axisMode')
      ? enumValue(record.axisMode, ['full', 'y-axis'], 'display-component-properties-invalid')
      : 'full',
  };
}

export class LookAtComponent extends BehaviourComponent {
  static typeId = 'behavior.look-at@1';
  static tickPhase = 'before-render';
  static drivesTransform = true;

  tick(frame) {
    const display = frame.display;
    const target = this.properties.targetNodeName === null
      ? this.properties.targetPosition
      : display.nodes.require(this.properties.targetNodeName).getWorldTransform().position;
    const node = this.node;
    const nodeWorld = node.getWorldTransform();
    const direction = [
      target[0] - nodeWorld.position[0],
      target[1] - nodeWorld.position[1],
      target[2] - nodeWorld.position[2],
    ];
    const parentWorld = node.parentName === null
      ? null : display.nodes.require(node.parentName).getWorldTransform();
    const localDirection = localDirectionForWorldFacing(
      parentWorld,
      direction,
      this.properties.axisMode,
    );
    const rotation = quaternionFromForward(localDirection, 'full');
    this.setDrivenLocalTransform({
      position: node.localTransform.position,
      rotationXyzw: rotation,
      scale: node.localTransform.scale,
    });
  }
}

export const LOOK_AT_COMPONENT_DESCRIPTOR = Object.freeze({
  ComponentClass: LookAtComponent,
  normalizeProperties: normalizeLookAtProperties,
  resourceReferences: () => [],
});
