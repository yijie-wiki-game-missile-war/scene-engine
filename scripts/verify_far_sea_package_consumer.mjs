#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, realpath, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Always install outside the workspace: no source imports or workspace dependency fallback.
let browserRequested = false;
const options = Object.fromEntries(process.argv.slice(2).filter(value => {
  if (value !== '--browser') return true;
  browserRequested = true; return false;
}).map(value => {
  const match = /^--(client|display|renderer|npm-cli)=(.+)$/.exec(value);
  if (!match) throw new Error('Expected --client=tarball --display=tarball --renderer=tarball [--npm-cli=path] [--browser]');
  return [match[1], path.resolve(match[2])];
}));
for (const key of ['client', 'display', 'renderer']) {
  if (!options[key] || !(await stat(options[key])).isFile()) throw new Error('Missing tarball: ' + key);
}
const npmCli = options['npm-cli'] ?? process.env.npm_execpath
  ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
if (!(await stat(npmCli)).isFile()) throw new Error('Supply --npm-cli for this Node installation');
const prefix = path.join(tmpdir(), 'scene-engine-package-consumer-');
const isolated = await mkdtemp(prefix);
const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'support/package-consumer');
const execute = (args, label) => {
  const result = spawnSync(process.execPath, args, { cwd: isolated, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, NODE_PATH: '' }, timeout: 180000 });
  if (result.status !== 0) throw new Error(label + ': ' + (result.error?.message ?? '') + '\n' + result.stdout + result.stderr);
  return result.stdout;
};
try {
  await writeFile(path.join(isolated, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execute([npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund',
    options.client, options.display, options.renderer, 'typescript@5.8.3'], 'isolated install');
  for (const name of ['types.ts', 'smoke.mjs']) await copyFile(path.join(fixtureRoot, name), path.join(isolated, name));
  await writeFile(path.join(isolated, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, exactOptionalPropertyTypes: true, noEmit: true, target: 'ES2022',
    module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022', 'DOM'], skipLibCheck: false,
  }, files: ['types.ts'] }));
  execute([path.join(isolated, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], 'public types');
  const packages = {};
  for (const name of ['client', 'display', 'renderer-three']) {
    const root = await realpath(path.join(isolated, 'node_modules/@scene-engine', name));
    if (!root.startsWith(isolated + path.sep)) throw new Error('Unexpected workspace dependency: ' + root);
    const descriptor = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    packages[name] = descriptor.version;
  }
  const smoke = JSON.parse(execute([path.join(isolated, 'smoke.mjs')], 'runtime smoke'));
  let browser = null;
  if (browserRequested) {
    // Reuse the same public runtime fixture against installed tarballs. The
    // temporary server has no route to sibling workspace source files.
    const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
    const support = path.join(isolated, 'scripts/support');
    await mkdir(path.join(support, 'texture-alpha'), { recursive: true });
    await copyFile(path.join(scriptRoot, 'benchmark_display_browser.mjs'),
      path.join(isolated, 'scripts/benchmark_display_browser.mjs'));
    for (const name of ['program_sprite_browser_validation.html', 'program_sprite_browser_validation.mjs'])
      await copyFile(path.join(scriptRoot, 'support', name), path.join(support, name));
    for (const name of ['atlas', 'data', 'palette', 'premultiplied', 'straight'])
      await copyFile(path.join(scriptRoot, 'support/texture-alpha', name + '.png'),
        path.join(support, 'texture-alpha', name + '.png'));
    browser = JSON.parse(execute([path.join(isolated, 'scripts/benchmark_display_browser.mjs'),
      '--fixture=program-sprite', '--viewport=1280x720', '--dpr=1'], 'packaged browser smoke'));
  }
  const hashes = {};
  for (const key of ['client', 'display', 'renderer']) hashes[key] = createHash('sha256').update(await readFile(options[key])).digest('hex');
  process.stdout.write(JSON.stringify({ status: 'PASS', packages, tarballSha256: hashes, types: 'PASS', smoke, browser }, null, 2) + '\n');
} finally {
  // Target was returned by mkdtemp; resolve and bound it before recursive cleanup.
  const resolved = await realpath(isolated);
  if (resolved.startsWith(prefix) && path.dirname(resolved) === path.resolve(tmpdir())) await rm(resolved, { recursive: true, force: true });
  else throw new Error('Unexpected consumer cleanup path: ' + resolved);
}
