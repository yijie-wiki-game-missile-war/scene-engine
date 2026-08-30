import { BehaviourComponent } from '../component/behaviour-component.js';
import { enumValue, exactKeys } from '../internal.js';
import { quaternionFromForward, quaternionFromForwardUp } from '../math/quaternion.js';
import { localDirectionForWorldFacing } from '../math/transform.js';
import { fail } from '../runtime/health.js';
import { assertNodeName } from '../node/node-name.js';

export function normalizeBillboardProperties(value) {
  const record = exactKeys(value, ['mode', 'axisMode'], ['facing', 'cameraName'],
    'display-component-properties-invalid');
  const facing = enumValue(Object.hasOwn(record, 'facing') ? record.facing : 'fixed', ['fixed', 'camera'],
    'display-component-properties-invalid');
  if (facing === 'fixed' && record.cameraName != null) fail('display-component-properties-invalid');
  return {
    facing,
    mode: enumValue(record.mode, ['initialize', 'continuous'], 'display-component-properties-invalid'),
    axisMode: enumValue(record.axisMode, ['full', 'y-axis'], 'display-component-properties-invalid'),
    cameraName: record.cameraName === null || !Object.hasOwn(record, 'cameraName')
      ? null : assertNodeName(record.cameraName),
  };
}

export class BillboardComponent extends BehaviourComponent {
  static typeId = 'behavior.billboard@2';
  static tickPhase = 'before-render';
  static drivesTransform = true;

  onAttach(display) {
    if (this.properties.mode === 'initialize' || this.properties.facing === 'fixed') this._orient(display);
  }

  tick(frame) {
    if (this.properties.mode === 'continuous') this._orient(frame.display);
  }

  _orient(display) {
    const node = this.node;
    const parentWorld = node.parentName === null
      ? null : display.nodes.require(node.parentName).getWorldTransform();
    // Fixed cards use the world's canonical +Z forward and +Y up. Resolve the
    // pose in Display's sole Node graph so rendering and picking share it.
    if (this.properties.facing !== 'camera') {
      const localForward = localDirectionForWorldFacing(parentWorld, [0, 0, 1], 'full');
      const localUp = localDirectionForWorldFacing(parentWorld, [0, 1, 0], 'full');
      this.setDrivenLocalTransform({
        position: node.localTransform.position,
        rotationXyzw: quaternionFromForwardUp(localForward, localUp),
        scale: node.localTransform.scale,
      });
      return;
    }
    const cameraName = this.properties.cameraName ?? display.scene.activeCameraName;
    if (cameraName === null) fail('display-active-camera-missing');
    const cameraPosition = display.nodes.require(cameraName).getWorldTransform().position;
    const nodeWorld = node.getWorldTransform();
    const direction = [
      cameraPosition[0] - nodeWorld.position[0],
      cameraPosition[1] - nodeWorld.position[1],
      cameraPosition[2] - nodeWorld.position[2],
    ];
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

export const BILLBOARD_COMPONENT_DESCRIPTOR = Object.freeze({
  ComponentClass: BillboardComponent,
  normalizeProperties: normalizeBillboardProperties,
  resourceReferences: () => [],
});
