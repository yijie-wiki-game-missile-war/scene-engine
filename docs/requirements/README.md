# Current requirements and proposals

Documents in this directory track agreed work and remaining acceptance requirements. They are not the current Scene Engine
contract. Implemented behavior is documented by the technical documents linked from the repository README; unfinished
requirements remain explicit here.

| Requirement | Status | Scope |
| --- | --- | --- |
| [Far Sea procedural rendering and shared projection](far-sea-procedural-rendering-and-projection.md) | Expanded in Display 0.21.0 / renderer-three 0.18.0; full resource-fault isolation and Arts visual acceptance open | Declarative procedural materials/backgrounds, all-shader projection, matching pointer queries, resource and visual-time lifecycle. |
| [Program billboard and anchor-extent integration plan](program-billboard-anchor-extent-plan.md) | Engine implemented and locally packaged in Display 0.21.0 / renderer-three 0.18.0; GPU matrix and isolated tarball consumer passed. Arts resumes only after user notification. | Compose program materials, associated alpha sampling and anchor-extent on one drawable; add post-projection image pivot and matching UV/depth/queries. |

Implementation must update the affected current contracts, release tuple, public types and tests in the same change. Moving a
document out of this list, or changing its status, does not by itself make the behavior current.
