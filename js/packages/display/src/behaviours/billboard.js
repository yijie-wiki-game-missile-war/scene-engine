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

  onAttach(context) {
    if (this.properties.mode === 'initialize') this._orient(context);
  }

  tick(frame) {
    if (this.properties.mode === 'continuous') this._orient(frame.display);
  }

  _orient(context) {
    const cameraName = this.properties.cameraName ?? context.scene.activeCameraName;
    if (cameraName === null) fail('display-active-camera-missing');
    context.nodeGraph.flushWorldTransforms();
    const camera = context.nodeIndex.require(cameraName);
    const node = this.node;
    const cameraPosition = camera._worldTransform?.position ?? camera.getWorldTransform().position;
    const direction = [
      cameraPosition[0] - node._worldTransform.position[0],
      cameraPosition[1] - node._worldTransform.position[1],
      cameraPosition[2] - node._worldTransform.position[2],
    ];
    const localDirection = localDirectionForWorldFacing(
      node.parent?._worldTransform ?? null,
      direction,
      this.properties.axisMode,
    );
    const rotation = quaternionFromForward(localDirection, 'full');
    node.setLocalTransform({
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
