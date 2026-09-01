import * as crypto from 'tacendum-crypto';
import {
  DEFAULT_PREVIEW_LEVEL,
  PREVIEW_LEASE_MS,
  PREVIEWS_ARMED_FILE,
  renewPreviews,
  PREVIEW_LEVEL_FILE,
  armPreviews,
  disarmPreviews,
  loadPreviewLevel,
  previewLevel,
  resetPreviewLevelForDuress,
  setPreviewLevel,
} from '../src/previews';

/**
 * How much of a message a notification may show, and whether it may show
 * anything at all.
 *
 * Two values, and they are different KINDS of thing. The level is a
 * preference; the armed marker is a claim about right now — that a real
 * session is open on this device. The marker's polarity is the part worth
 * testing hardest, because getting it backwards fails open.
 */

const shared = (crypto as unknown as { __sharedState: Map<string, string> })
  .__sharedState;
const keychain = (crypto as unknown as { __keychain: Map<string, string> })
  .__keychain;

beforeEach(() => {
  shared.clear();
  keychain.clear();
  resetPreviewLevelForDuress();
  jest.clearAllMocks();
});

describe('the preview level', () => {
  it('defaults to name-only, not to full', async () => {
    // The middle option is useful without being a disclosure. Someone who
    // wants the message text can ask; someone who would be harmed by it must
    // not have to discover the setting first.
    await loadPreviewLevel();

    expect(previewLevel()).toBe('sender');
    expect(DEFAULT_PREVIEW_LEVEL).toBe('sender');
  });

  it('round-trips a choice through the file', async () => {
    await setPreviewLevel('full');

    expect(shared.get(PREVIEW_LEVEL_FILE)).toBe('full');

    resetPreviewLevelForDuress(); // clear the in-memory mirror
    await loadPreviewLevel();
    expect(previewLevel()).toBe('full');
  });

  it('is a FILE, never the Keychain', async () => {
    // The whole reason this module exists. The extension that renders the
    // notification cannot read the Keychain — reaching it needs a shared
    // access group, and adding one rewrites the access group of items that
    // already exist, including the lock passcode verifier.
    await setPreviewLevel('none');

    expect(keychain.size).toBe(0);
    expect(crypto.setSecret).not.toHaveBeenCalled();
    expect(crypto.writeSharedState).toHaveBeenCalledWith(
      PREVIEW_LEVEL_FILE,
      'none',
    );
  });

  it('falls back to the default when the file holds something unrecognised', async () => {
    // A value from a newer build, or a truncated write. Anything that is not
    // one of the three levels is not a level.
    shared.set(PREVIEW_LEVEL_FILE, 'everything');

    await loadPreviewLevel();

    expect(previewLevel()).toBe('sender');
  });

  it('falls back to the default when the read throws', async () => {
    (crypto.readSharedState as jest.Mock).mockRejectedValueOnce(
      new Error('container unavailable'),
    );

    await expect(loadPreviewLevel()).resolves.toBeUndefined();
    expect(previewLevel()).toBe('sender');
  });
});

describe('the armed marker', () => {
  it('is created by arming and DELETED by disarming', async () => {
    // Deleted, not set to '0'. The extension checks for the file's absence,
    // so every way this can fail — a crash, a lost write, a restore, a fresh
    // install — has to land on "no preview".
    await armPreviews();
    expect(shared.has(PREVIEWS_ARMED_FILE)).toBe(true);

    await disarmPreviews();
    expect(shared.has(PREVIEWS_ARMED_FILE)).toBe(false);
    expect(crypto.deleteSharedState).toHaveBeenCalledWith(PREVIEWS_ARMED_FILE);
  });

  it('is absent before anything has happened', async () => {
    // The state after a fresh install, and after a reboot with no unlock.
    expect(shared.has(PREVIEWS_ARMED_FILE)).toBe(false);
  });

  it('disarming twice is not an error', async () => {
    // Relock can follow a duress entry, and both disarm.
    await armPreviews();
    await disarmPreviews();

    await expect(disarmPreviews()).resolves.toBeUndefined();
    expect(shared.has(PREVIEWS_ARMED_FILE)).toBe(false);
  });

  it('writes a LEASE — a deadline the extension can check, not a bare flag', async () => {
    // A flag can only be revoked by a write, and the duress path may not be
    // able to write. A lease expires on its own: files that stop being
    // renewed disarm themselves, no write required at duress time.
    const before = Date.now();
    await armPreviews();

    const marker = JSON.parse(shared.get(PREVIEWS_ARMED_FILE) ?? 'null') as {
      v: number;
      deadline: number;
    };
    expect(marker.v).toBe(1);
    expect(marker.deadline).toBeGreaterThanOrEqual(before + PREVIEW_LEASE_MS);
    expect(marker.deadline).toBeLessThanOrEqual(Date.now() + PREVIEW_LEASE_MS);
  });

  it('renewal pushes the deadline out again', async () => {
    await armPreviews();
    const first = JSON.parse(shared.get(PREVIEWS_ARMED_FILE)!) as { deadline: number };

    await new Promise<void>(r => setTimeout(() => r(), 5));
    await renewPreviews();

    const second = JSON.parse(shared.get(PREVIEWS_ARMED_FILE)!) as { deadline: number };
    expect(second.deadline).toBeGreaterThan(first.deadline);
  });

  it('falls back to OVERWRITING when the delete fails', async () => {
    // Two independent routes to the same state. A delete and a write fail for
    // different reasons, and a container that will not unlink a file is often
    // still willing to truncate one. Anything that is not ARMED reads as
    // disarmed, so a '0' is as good as an absence.
    await armPreviews();
    (crypto.deleteSharedState as jest.Mock).mockRejectedValueOnce(
      new Error('read-only volume'),
    );

    await expect(disarmPreviews()).resolves.toBeUndefined();

    // '0' does not parse as a live lease, so the extension reads it as
    // disarmed — the overwrite is as good as the delete.
    expect(shared.get(PREVIEWS_ARMED_FILE)).toBe('0');
  });

  it('propagates only when BOTH routes fail', async () => {
    // The caller's signal that previews may still render. No caller lets it
    // stop them — the duress path must reach the decoy whatever happens —
    // but it must be a real failure and not a silent one.
    (crypto.deleteSharedState as jest.Mock).mockRejectedValueOnce(
      new Error('read-only volume'),
    );
    (crypto.writeSharedState as jest.Mock).mockRejectedValueOnce(
      new Error('container locked'),
    );

    await expect(disarmPreviews()).rejects.toThrow('container locked');
  });
});

describe('duress', () => {
  it('shows the default in settings without touching the stored choice', async () => {
    // The owner's real preference is real state and stays sealed. Nothing is
    // rendered from a decoy session anyway, so this is only about what the
    // settings screen displays — and a duress session must not be able to
    // overwrite what the owner chose.
    await setPreviewLevel('full');

    resetPreviewLevelForDuress();

    expect(previewLevel()).toBe('sender');
    expect(shared.get(PREVIEW_LEVEL_FILE)).toBe('full');
  });
});
