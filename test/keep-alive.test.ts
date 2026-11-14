import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepAliveUrl, loadConfig } from '../src/config.js';
import { KeepAlive } from '../src/keep-alive.js';
import { createLogger } from '../src/lib/logger.js';
import { eventually } from './helpers/fake-engine.js';
import { testConfig } from './helpers/env.js';

const logger = createLogger('silent');
const ok = () => Promise.resolve(new Response('{"status":"ok"}', { status: 200 }));

test('it asks for /healthz on its own address, again and again, until stopped', async () => {
  const urls: string[] = [];
  const keepAlive = new KeepAlive({ url: 'https://gateway.onrender.com', intervalMs: 15, fetch: (async (url: string) => { urls.push(url); return ok(); }) as typeof fetch }, logger);
  keepAlive.start();
  await eventually(() => urls.length >= 3);
  keepAlive.stop();
  const seen = urls.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(urls.length, seen, 'it stops when told to');
  assert.ok(urls.every((url) => url === 'https://gateway.onrender.com/healthz'));
});

test('a path on the address is replaced, not appended to', async () => {
  const urls: string[] = [];
  const keepAlive = new KeepAlive({ url: 'https://gateway.onrender.com/some/path/', intervalMs: 1_000, fetch: (async (url: string) => { urls.push(url); return ok(); }) as typeof fetch }, logger);
  await keepAlive.ping();
  assert.deepEqual(urls, ['https://gateway.onrender.com/healthz']);
});

test('a failing ping never throws and never stops the timer; it recovers on its own', async () => {
  let healthy = false;
  const calls: number[] = [];
  const warnings: string[] = [];
  const quiet = { ...logger, warn: (_meta: unknown, message: string) => warnings.push(message), info: () => undefined } as unknown as typeof logger;
  const fetcher = (async () => {
    calls.push(Date.now());
    if (!healthy) throw new TypeError('fetch failed');
    return ok();
  }) as typeof fetch;
  const keepAlive = new KeepAlive({ url: 'https://gateway.onrender.com', intervalMs: 10, fetch: fetcher }, quiet);

  assert.equal(await keepAlive.ping(), false);
  keepAlive.start();
  await eventually(() => calls.length >= 4);
  assert.equal(warnings.length, 1, 'a failure that keeps happening is logged once, not on every try');

  healthy = true;
  const before = calls.length;
  await eventually(() => calls.length > before + 1);
  assert.equal(await keepAlive.ping(), true, 'and it is working again');
  keepAlive.stop();
});

test('an error status counts as a failure', async () => {
  const keepAlive = new KeepAlive({ url: 'https://gateway.onrender.com', intervalMs: 1_000, fetch: (async () => new Response('x', { status: 502 })) as typeof fetch }, logger);
  assert.equal(await keepAlive.ping(), false);
});

test("config: Render's own address is used by default, an explicit one wins, and off Render it is off", () => {
  assert.equal(keepAliveUrl(testConfig()), null);
  assert.equal(keepAliveUrl(testConfig({ RENDER_EXTERNAL_URL: 'https://gateway.onrender.com' })), 'https://gateway.onrender.com');
  assert.equal(keepAliveUrl(testConfig({ RENDER_EXTERNAL_URL: 'https://gateway.onrender.com', KEEP_ALIVE_URL: 'https://custom.example.com' })), 'https://custom.example.com');
  assert.equal(testConfig().KEEP_ALIVE_MINUTES, 10);
  assert.throws(() => testConfig({ KEEP_ALIVE_MINUTES: '15' }), /KEEP_ALIVE_MINUTES/, 'it must be under the 15-minute sleep timeout');
  assert.throws(() => testConfig({ KEEP_ALIVE_MINUTES: '0' }), /KEEP_ALIVE_MINUTES/);
  assert.throws(() => loadConfig({ ...process.env, KEEP_ALIVE_URL: 'not a url' }), /KEEP_ALIVE_URL|Invalid configuration/);
});
