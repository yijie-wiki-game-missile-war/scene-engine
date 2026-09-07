#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FIXTURES = Object.freeze({
  display: 'display_browser_benchmark.html',
  'upper-field': 'upper_field_browser_validation.html',
  anchor: 'anchor_extent_browser_validation.html',
  program: 'program_browser_validation.html',
  'program-frame': 'program_frame_browser_validation.html',
  'program-batch': 'program_batch_browser_validation.html',
  'program-scale': 'program_scale_browser_benchmark.html',
  'program-sprite-scale': 'program_scale_browser_benchmark.html',
  'program-sprite': 'program_sprite_browser_validation.html',
  'texture-alpha': 'texture_alpha_browser_validation.html',
  generated: 'generated_texture_browser_validation.html',
});
const MAXIMUM_BINDINGS = 50_000;
const MAXIMUM_TICKS = 100_000;
const MAXIMUM_TIMEOUT_MS = 600_000;
const CDP_COMMAND_TIMEOUT_MS = 10_000;

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const chrome = process.env.SCENE_ENGINE_BENCHMARK_CHROME ?? DEFAULT_CHROME;
  await requireFile(chrome, 'Chrome executable');
  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'scene-engine-browser-benchmark-'));
  const server = createServer(serveRepositoryFile);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('benchmark server address unavailable');
    const query = new URLSearchParams({
      bindings: String(options.bindings),
      ticks: String(options.ticks),
      updateRatio: String(options.updateRatio),
      projection: options.projection,
      representation: options.fixture === 'program-sprite-scale' ? 'sprite' : 'mesh',
      evidence: options.evidence ? '1' : '0',
      width: String(options.width), height: String(options.height),
    });
    const url = `http://127.0.0.1:${address.port}/scripts/support/${FIXTURES[options.fixture]}?${query}`;
    const report = await runChrome(chrome, profileDirectory, url, options.timeoutMs, options.dpr);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'READY') process.exitCode = 1;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const expectedPrefix = `${path.join(os.tmpdir(), 'scene-engine-browser-benchmark-')}`;
    if (!profileDirectory.startsWith(expectedPrefix)) {
      throw new Error('refusing to remove an unexpected browser profile directory');
    }
    await rm(profileDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }).catch((error) => {
      // A Windows browser helper may release its profile lock after its main
      // process exits. Do not replace the actual test result with cleanup noise.
      if (error.code !== 'EBUSY' && error.code !== 'EPERM') throw error;
      process.stderr.write(`Browser profile remains locked: ${profileDirectory}\n`);
    });
  }
}

function parseArguments(arguments_) {
  let fixture = 'display';
  let evidence = false;
  let dpr = 1;
  let projection = 'perspective';
  let width = 640, height = 480;
  let bindings = 500;
  let ticks = 60;
  let updateRatio = 0.01;
  let timeoutMs = 120_000;
  for (const argument of arguments_) {
    if (argument === '--evidence') { evidence = true; continue; }
    if (argument.startsWith('--fixture=')) {
      fixture = argument.slice('--fixture='.length);
      if (!Object.hasOwn(FIXTURES, fixture)) throw new Error('unknown fixture: ' + fixture);
      continue;
    }
    if (argument === '--projection=orthographic') { projection = 'orthographic'; continue; }
    const viewport = /^--viewport=([0-9]+)x([0-9]+)$/.exec(argument);
    if (viewport) { width = positiveInteger(viewport[1], 'width'); height = positiveInteger(viewport[2], 'height'); continue; }
    if (argument === '--dpr=1' || argument === '--dpr=1.25' || argument === '--dpr=2') { dpr = Number(argument.slice(6)); continue; }
    const match = /^(--bindings|--ticks|--update-ratio|--timeout-ms)=([^=]+)$/u.exec(argument);
    if (match === null) throw new Error(`unknown option: ${argument}`);
    const [, name, raw] = match;
    if (name === '--bindings') {
      bindings = positiveInteger(raw, 'bindings');
      if (bindings > MAXIMUM_BINDINGS) {
        throw new Error(`bindings must not exceed ${MAXIMUM_BINDINGS}`);
      }
    }
    else if (name === '--ticks') {
      ticks = positiveInteger(raw, 'ticks');
      if (ticks > MAXIMUM_TICKS) throw new Error(`ticks must not exceed ${MAXIMUM_TICKS}`);
    }
    else if (name === '--update-ratio') updateRatio = ratio(raw);
    else if (name === '--timeout-ms') {
      timeoutMs = positiveInteger(raw, 'timeout-ms');
      if (timeoutMs > MAXIMUM_TIMEOUT_MS) {
        throw new Error(`timeout-ms must not exceed ${MAXIMUM_TIMEOUT_MS}`);
      }
    }
  }
  return { bindings, ticks, updateRatio, timeoutMs, fixture, dpr, projection, width, height, evidence };
}

function positiveInteger(raw, name) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function ratio(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('update-ratio must be in [0, 1]');
  }
  return value;
}

async function requireFile(target, label) {
  let value;
  try { value = await stat(target); } catch { throw new Error(`${label} not found: ${target}`); }
  if (!value.isFile()) throw new Error(`${label} is not a file: ${target}`);
}

async function runChrome(chrome, profileDirectory, url, timeoutMs, dpr) {
  const arguments_ = [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-extensions',
    '--disable-sync',
    '--enable-logging=stderr',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--remote-allow-origins=*',
    '--remote-debugging-port=0',
    '--run-all-compositor-stages-before-draw',
    `--force-device-scale-factor=${dpr}`,
    '--window-size=1280,720',
    `--user-data-dir=${profileDirectory}`,
    url,
  ];
  const child = spawn(chrome, arguments_, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  child.stderr.setEncoding('utf8');
  let stderr = '';
  let socket;
  let cdp;
  const deadline = Date.now() + timeoutMs;
  try {
    const devToolsUrl = await new Promise((resolve, reject) => {
      const startupTimeout = setTimeout(() => {
        reject(new Error(`Chrome DevTools endpoint did not start\n${stderr.trim()}`));
      }, Math.min(timeoutMs, 15_000));
      child.once('error', (error) => {
        clearTimeout(startupTimeout);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(startupTimeout);
        reject(new Error(`Chrome exited ${code} before DevTools was ready\n${stderr.trim()}`));
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/u);
        if (match !== null) {
          clearTimeout(startupTimeout);
          resolve(match[1]);
        }
      });
    });
    socket = await openWebSocket(devToolsUrl, remaining(deadline));
    cdp = createCdpClient(socket);
    const target = await waitForPageTarget(cdp, url, deadline);
    const attached = await cdp.command('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;
    await cdp.command('Runtime.enable', {}, sessionId);
    while (Date.now() < deadline) {
      const evaluated = await cdp.command('Runtime.evaluate', {
        expression: 'document.body?.dataset?.result ?? null',
        returnByValue: true,
      }, sessionId, remaining(deadline));
      const encoded = evaluated.result?.value;
      if (typeof encoded === 'string' && encoded.length > 0) {
        return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      }
      await delay(25);
    }
    const diagnostic = await cdp.command('Runtime.evaluate', {
      expression: `JSON.stringify({
        href: location.href,
        readyState: document.readyState,
        title: document.title,
        state: document.body?.dataset?.state ?? null,
        text: document.body?.innerText?.slice(0, 500) ?? ''
      })`,
      returnByValue: true,
    }, sessionId).catch(() => null);
    throw new Error(`Chrome benchmark exceeded ${timeoutMs} ms; page=${diagnostic?.result?.value ?? 'unavailable'}\n${stderr.trim()}`);
  } finally {
    if (cdp !== undefined) await cdp.command('Browser.close').catch(() => undefined);
    if (socket !== undefined) socket.close();
    if (!(await waitForChildExit(child, 2_000))) {
      child.kill('SIGKILL');
      await waitForChildExit(child, 2_000);
    }
  }
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.removeListener('close', exited);
      resolve(false);
    }, timeoutMs);
    function exited() {
      clearTimeout(timeout);
      resolve(true);
    }
    child.once('close', exited);
  });
}

function openWebSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('Chrome DevTools WebSocket connection timed out'));
    }, timeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve(socket);
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('Chrome DevTools WebSocket connection failed'));
    }, { once: true });
  });
}

function createCdpClient(socket) {
  let nextIdentity = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    clearTimeout(waiter.timeout);
    if (message.error !== undefined) {
      waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
    } else {
      waiter.resolve(message.result ?? {});
    }
  });
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('Chrome DevTools connection closed'));
    }
    pending.clear();
  });
  return {
    command(method, params = {}, sessionId = undefined, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
      const id = nextIdentity;
      nextIdentity += 1;
      const message = { id, method, params };
      if (sessionId !== undefined) message.sessionId = sessionId;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Chrome DevTools command timed out: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timeout });
        try {
          socket.send(JSON.stringify(message));
        } catch (error) {
          clearTimeout(timeout);
          pending.delete(id);
          reject(error);
        }
      });
    },
  };
}

async function waitForPageTarget(cdp, url, deadline) {
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.command('Target.getTargets');
    const target = targetInfos.find((value) => value.type === 'page' && value.url === url)
      ?? targetInfos.find((value) => value.type === 'page');
    if (target !== undefined) return target;
    await delay(25);
  }
  throw new Error('Chrome benchmark page target was not created');
}

function remaining(deadline) {
  return Math.max(1, deadline - Date.now());
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function serveRepositoryFile(request, response) {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const target = path.resolve(ROOT, `.${pathname}`);
    if (target !== ROOT && !target.startsWith(`${ROOT}${path.sep}`)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    const bytes = await readFile(target);
    response.writeHead(200, {
      'content-type': contentType(target),
      'cache-control': 'no-store',
      'cross-origin-resource-policy': 'same-origin',
    });
    response.end(bytes);
  } catch {
    response.writeHead(404).end('not found');
  }
}

function contentType(target) {
  switch (path.extname(target)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
