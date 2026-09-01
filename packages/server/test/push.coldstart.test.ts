import { describe, expect, it } from 'vitest';
import { makeApnsCredentialsLoader } from '../src/push/sender.js';

/**
 * The cold-container drop, found live in production. The credentials loader
 * answers "no key yet" while its Secrets Manager fetch is in flight — the
 * right shape for the HTTP path, and exactly wrong for the push worker: push
 * traffic is sparse, so the cold container is the COMMON case, and the one
 * push a wake will ever get was dropped there. The worker now awaits
 * `settled()` between constructing deps (which kicks the fetch) and
 * delivering; these pin the surface it depends on.
 */

const SECRET = JSON.stringify({
  keyId: 'K1',
  teamId: 'T1',
  bundleId: 'com.example.app',
  privateKeyP8: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
});

describe('the cold-start fetch is awaitable', () => {
  it('settled() resolves when the in-flight fetch lands, and the loader then answers', async () => {
    let release!: (v: string) => void;
    const load = makeApnsCredentialsLoader(
      () => new Promise<string>((r) => (release = r)),
    );

    // First call kicks the fetch and honestly has no answer yet.
    expect(load('arn:test')).toBeUndefined();

    // The gate must actually WAIT: give a fake immediately-resolving
    // settled() every chance to fire before the fetch lands, and require
    // that it has not — this is what separates the real await from a
    // Promise.resolve() that merely drains the same microtasks.
    let opened = false;
    const gate = load.settled().then(() => {
      opened = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(opened).toBe(false);

    release(SECRET);
    await gate;

    // After the awaited fetch, the SAME call answers — this is the line that
    // used to be a dropped push.
    expect(opened).toBe(true);
    expect(load('arn:test')).toMatchObject({ keyId: 'K1' });
  });

  it('settled() never rejects — a failed fetch degrades the push, not the worker', async () => {
    let reject!: (e: Error) => void;
    const load = makeApnsCredentialsLoader(
      () => new Promise<string>((_, rj) => (reject = rj)),
    );
    load('arn:test');

    const gate = load.settled();
    reject(new Error('secrets manager down'));

    await expect(gate).resolves.toBeUndefined();
  });

  it('settled() with nothing in flight resolves immediately', async () => {
    const load = makeApnsCredentialsLoader(async () => SECRET);
    await expect(load.settled()).resolves.toBeUndefined();
  });
});
