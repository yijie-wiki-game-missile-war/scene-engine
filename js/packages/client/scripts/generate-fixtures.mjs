import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The Python generator is the sole writer for cross-language fixtures.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const result = spawnSync('uv', ['run', 'python', 'scripts/generate_fixtures.py'], {
  cwd: root,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
