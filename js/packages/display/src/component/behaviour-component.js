import { Component } from './component.js';

export class BehaviourComponent extends Component {
  static tickPhase = null;
  tick() {}
}

export function behaviourHasTick(component) {
  return component instanceof BehaviourComponent
    && component.tick !== BehaviourComponent.prototype.tick;
}
