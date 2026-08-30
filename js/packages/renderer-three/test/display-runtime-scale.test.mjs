import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const BENCHMARK = fileURLToPath(new URL(
  '../../../../scripts/benchmark_display_runtime_scale.mjs',
  import.meta.url,
));

test('Display runtime scale CLI reports deterministic structure and complete disposal', () => {
  const completed = spawnSync(process.execPath, [
    BENCHMARK,
    '--bindings=12',
    '--profile=static-mesh',
    '--quick',
    '--ticks=2',
    '--warmup=0',
    '--update-ratio=0.25',
  ], {
    cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
    encoding: 'utf8',
    timeout: 15_000,
  });

  assert.equal(completed.error, undefined);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(completed.stderr, '');
  assert.equal(completed.stdout.trim().split('\n').length, 1);
  const report = JSON.parse(completed.stdout);
  assert.equal(report.schema, 'scene-engine-display-runtime-scale@2');
  assert.equal(report.status, 'QUICK PASS');
  assert.deepEqual(report.configuration, {
    profile: 'static-mesh',
    requestedBindings: 12,
    measuredTicks: 2,
    warmupTicks: 0,
    updateRatio: 0.25,
    measuredLogicalUpdates: 6,
    authoritativeRateHz: 60,
    renderer: 'ThreeRenderBackend with deterministic TestRenderer',
    networkAccess: false,
    nestedMutationMode: null,
  });
  assert.equal(report.fixture.objectBindings, 12);
  assert.equal(report.fixture.authorityRoots, 12);
  assert.equal(report.fixture.prefabLocalNodes, 0);
  assert.equal(report.fixture.backend.bindingCount, 13);
  assert.equal(report.fixture.backend.batchCount, 1);
  assert.equal(report.fixture.backend.instanceCount, 12);
  assert.deepEqual(report.finalCursor, { commitSeq: 2, sourceTick: 2, lastCommandSeq: 6 });
  assert.equal(report.timings.commit.samples, 2);
  assert.equal(report.timings.frame.samples, 2);
  assert.equal(report.memory.map((entry) => entry.stage).join(','),
    'before,after-create,after-ticks,after-rebuild,after-dispose');
  assert.equal(report.lifecycle.counts.backendCount, 2);
  assert.equal(report.lifecycle.returnedToZero, true);
  assert.deepEqual(report.healthEvents, []);
  assert.deepEqual({
    structure: report.checks.structure,
    cursor: report.checks.cursor,
    rebuild: report.checks.rebuild,
    health: report.checks.health,
    disposal: report.checks.disposal,
  }, {
    structure: true,
    cursor: true,
    rebuild: true,
    health: true,
    disposal: true,
  });

  for (const profile of ['static-sprite', 'mixed', 'nested', 'animated-sprite']) {
    const profileRun = spawnSync(process.execPath, [
      BENCHMARK,
      '--bindings=8',
      `--profile=${profile}`,
      '--quick',
      '--ticks=1',
      '--warmup=0',
      '--update-ratio=0.25',
    ], {
      cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(profileRun.error, undefined, profile);
    assert.equal(profileRun.status, 0, `${profile}: ${profileRun.stderr}`);
    const profileReport = JSON.parse(profileRun.stdout);
    assert.equal(profileReport.status, 'QUICK PASS', profile);
    assert.equal(profileReport.configuration.profile, profile);
    assert.equal(profileReport.checks.structure, true, profile);
    assert.equal(profileReport.checks.transforms, true, profile);
    assert.equal(profileReport.checks.rebuild, true, profile);
    assert.equal(profileReport.checks.disposal, true, profile);
  }
});
