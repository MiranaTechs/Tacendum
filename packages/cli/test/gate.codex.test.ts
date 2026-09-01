import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStores } from '../src/stores.js';
import { loadOrGenerateKeys } from '../src/messaging.js';
import { resolveRecipient } from '../src/profile.js';
import { CliError } from '../src/exit.js';

/** External review gate, 2026-07-28. */

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tacendum-codex-'));
  process.env.TACENDUM_HOME = home;
});
afterEach(() => {
  delete process.env.TACENDUM_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('pruning must not delete a key that was ever published', () => {
  it('keeps a generation until several pool replacements have passed', async () => {
    // A sender fetched a bundle from generation 1 and has not sent yet. Three
    // more registrations must not remove the private half it will need — a
    // count-based prune deleted the lowest surviving ids, which says nothing
    // about whether the server ever advertised them.
    const first = await loadOrGenerateKeys(new FileStores('bot'));
    const g1 = first.oneTimePrekeys.map((p) => p.keyId);

    await loadOrGenerateKeys(new FileStores('bot'));
    await loadOrGenerateKeys(new FileStores('bot'));

    const held = new FileStores('bot').prekeys.ids();
    for (const id of g1) expect(held).toContain(id);
  });

  it('grows rather than pruning — an unbounded store beats a lost message', async () => {
    // REVERSED at an earlier revision. Pruning was removed outright, because no local
    // record is evidence about what the SERVER is still advertising: a
    // rotation that fails before PUT /v1/keys advances local generations while
    // the server pool is untouched, so a generation window deleted private
    // halves for keys still being handed out — and the resulting message
    // cannot decrypt and is acked away as poison. A retained key costs 71
    // bytes; a deleted one costs a message, permanently. `nextId()` computes
    // its maximum by iteration, so growth cannot stack-overflow the allocator
    // either. A safe prune needs a floor recorded at upload-success time,
    // which is noted in messaging.ts for whoever adds it.
    // AMENDED at an earlier revision. Growth is bounded now WITHOUT pruning, which is the
    // outcome both constraints wanted: a rotation whose upload never happened
    // is reused rather than abandoned, so a failed or repeated registration no
    // longer strands 100 files each time. Nothing published is ever reclaimed —
    // that is still the rule pruning was removed for — but nothing unpublished
    // accumulates either. The old expectation (8 registrations, 800 keys) was
    // measuring the leak.
    for (let i = 0; i < 8; i++) await loadOrGenerateKeys(new FileStores('bot'));
    const held = new FileStores('bot').prekeys.ids();
    expect(held.length).toBeGreaterThan(0);
    expect(held.length).toBeLessThanOrEqual(300);
  });
});

describe('an account that predates the high-water mark', () => {
  it('never reissues an id the directory can no longer remember', () => {
    // The migration case: prekeys 1..100 issued by the old scheme, the highest
    // consumed and deleted, and no mark on disk. Deriving the next id from the
    // surviving files alone reissues 100 under a different key.
    const stores = new FileStores('legacy');
    for (let i = 1; i <= 99; i++) {
      writeFileSync(join(stores.root, 'prekeys', `${i}.bin`), 'x');
    }
    expect(stores.prekeys.nextId()).toBeGreaterThan(100);
  });

  it('does not apply the legacy jump to a brand-new store', () => {
    expect(new FileStores('fresh').prekeys.nextId()).toBe(1);
  });
});

describe('the recipient is never echoed when it could be a message body', () => {
  it('redacts a long secret that landed in the recipient slot', () => {
    // `tacendum send ci "$SECRET"` — one missing argument — puts the body here,
    // and this error reaches stderr and --json, i.e. CI and hook logs.
    const secret = 'sk-live-9f3a2b1c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1';
    let msg = '';
    try {
      resolveRecipient(secret);
    } catch (err) {
      msg = (err as CliError).message;
    }
    expect(msg).not.toContain('sk-live');
    expect(msg).toContain('that recipient');
  });

  it('does not name even a plausible client name — the echo is gone entirely', () => {
    // REVERSED at an earlier revision, and the reversal is the point. This used to assert
    // that a name-shaped recipient IS echoed, "which is the useful case" — but
    // `ci-bot` and `AKIAIOSFODNN7EXAMPLE` match the same regex, so the rule
    // that echoed one echoed the other. Two shape allowlists were tried and
    // both leaked a secret into stderr and --json, i.e. into CI and hook logs.
    // The only provably-safe value to echo would be a name that EXISTS on this
    // disk, and nonexistence is precisely what this branch just established —
    // so there is nothing safe left to print, and nothing is printed.
    try {
      resolveRecipient('ci-bot');
    } catch (err) {
      expect((err as CliError).message).not.toContain('ci-bot');
      expect((err as CliError).message).toContain('that recipient');
    }
  });
});
