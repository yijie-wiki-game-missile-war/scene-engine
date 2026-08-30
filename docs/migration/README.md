# Scene Engine Display P1 migration package

> **Completed historical migration package:** use the current source, `README.md`, and current contract documents for implementation facts.


This directory records the execution package used for the Display contract closeout found during the 2026-08-25 audit.
Do not execute it as the current plan; its target changes have been absorbed into the current source and contracts.

Read and execute in this order:

1. `display-runtime-p1-remediation.md` — binding execution plan for all four P1 items.
2. `prefab-identity.md` — deeper explanation of Prefab ID versus gameplay type.
3. `../reviews/display-runtime-audit-2026-08-25.md` — audit basis and original findings.
4. `.agents/skills/scene-engine/SKILL.md` — target public usage after the migration is complete.

The package was a **documentation and Skill overlay** before implementation. It is retained only to explain the migration
intent and original findings; current implementation decisions come from the source, `README.md`, and current contract documents.

The migration is intentionally breaking. Do not retain aliases for `logicalType`, `prefabType`, or `prefab_type`, and do not
add a compatibility registry or fallback lookup path.
