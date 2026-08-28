import { BehaviourComponent } from '../component/behaviour-component.js';
import { enumValue, exactKeys } from '../internal.js';
import { quaternionFromForward } from '../math/quaternion.js';
import { localDirectionForWorldFacing } from '../math/transform.js';
import { fail } from '../runtime/health.js';
import { assertNodeName } from '../node/node-name.js';

export function normalizeBillboardProperties(value) {
  const record = exactKeys(value, ['mode', 'axisMode'], ['cameraName'],
    'display-component-properties-invalid');
  return {
    mode: enumValue(record.mode, ['initialize', 'continuous'], 'display-component-properties-invalid'),
    axisMode: enumValue(record.axisMode, ['full', 'y-axis'], 'display-component-properties-invalid'),
    cameraName: record.cameraName === null || !Object.hasOwn(record, 'cameraName')
      ? null : assertNodeName(record.cameraName),
  };
}

export class BillboardComponent extends BehaviourComponent {
  static typeId = 'behavior.billboard@1';
  static tickPhase = 'before-render';
  static drivesTransform = true;

  onAttach(display) {
    if (this.properties.mode === 'initialize') this._orient(display);
  }

  tick(frame) {
    if (this.properties.mode === 'continuous') this._orient(frame.display);
  }

  _orient(display) {
    const cameraName = this.properties.cameraName ?? display.scene.activeCameraName;
    if (cameraName === null) fail('display-active-camera-missing');
    const cameraPosition = display.nodes.require(cameraName).getWorldTransform().position;
    const node = this.node;
    const nodeWorld = node.getWorldTransform();
    const direction = [
      cameraPosition[0] - nodeWorld.position[0],
      cameraPosition[1] - nodeWorld.position[1],
      cameraPosition[2] - nodeWorld.position[2],
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

export const BILLBOARD_COMPONENT_DESCRIPTOR = Object.freeze({
  ComponentClass: BillboardComponent,
  normalizeProperties: normalizeBillboardProperties,
  resourceReferences: () => [],
});
