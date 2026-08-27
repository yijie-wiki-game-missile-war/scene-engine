# Scene Engine Display P1 migration package

This directory is the execution entry for the Display contract closeout found during the 2026-08-25 audit.

Read and execute in this order:

1. `display-runtime-p1-remediation.md` — binding execution plan for all four P1 items.
2. `prefab-identity.md` — deeper explanation of Prefab ID versus gameplay type.
3. `../reviews/display-runtime-audit-2026-08-25.md` — evidence and original findings.
4. `.agents/skills/scene-engine/SKILL.md` — target public usage after the migration is complete.

The package is a **documentation and Skill overlay**. It does not claim that source files have already been fixed. Codex must
make the source, fixture, test, package-version, and current-document changes described in the remediation plan, then run the
full acceptance gates. Do not install only the target Skill while leaving the old `logicalType`/`prefabType` implementation in
place.

The migration is intentionally breaking. Do not retain aliases for `logicalType`, `prefabType`, or `prefab_type`, and do not
add a compatibility registry or fallback lookup path.
