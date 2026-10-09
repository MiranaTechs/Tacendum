/**
 * The scan side of the linking ceremony, on glass:
 *
 *  - every way the scan can fail is said in its own words. A
 *    camera that would not open, a photo library the app may not read, a
 *    photo too large or carrying two codes, and a network that never
 *    answered all used to render as "the link may have expired, or the slot
 *    may be taken" — a sentence about a server refusal the server never
 *    made. The class is the contract, never the thrown text.
 *  - the waiting phase shows the offer's own clock, says what a
 *    mismatch on the other screen means, and offers a way to stop waiting.
 *    Stopping keeps the pending row: the server has no withdrawal route and
 *    that row is this device's only path to a late acceptance.
 *
 * The readers and the ceremony are spied at their seams; the screen's job —
 * which sentence, which phase — is what is asserted. */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { ApiRequestError, ApiTimeoutError } from '../src/api';
import type { ProfileRow } from '../src/db';
import { LINKING_COPY, OffererCeremony } from '../src/linking';
import * as media from '../src/media';
import * as qr from '../src/qr';
import { LinkDeviceScreen } from '../src/screens/LinkDeviceScreen';

const SELF = '01HQAAAA00000000000000000A';
const OTHER = '01HQBBBB00000000000000000B';
const NOW_MS = 1_756_000_000_000;
const EXPIRES = Math.floor(NOW_MS / 1000) + 600;
const CODE = '111112222233333444445555566666777778888899999000001111122222';
const PROFILE: ProfileRow = {
  userId: SELF,
  registrationId: 7,
  displayName: 'Nat',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

function fakeCeremony(over: Record<string, unknown> = {}): OffererCeremony {
  return {
    phase: 'code',
    code: CODE,
    acceptorId: OTHER,
    expiresAt: EXPIRES,
    confirm: jest.fn().mockResolvedValue(undefined),
    checkLinked: jest.fn().mockResolvedValue(false),
    cancel: jest.fn(),
    ...over,
  } as unknown as OffererCeremony;
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <LinkDeviceScreen profile={PROFILE} onBack={() => {}} onDone={() => {}} />,
    );
  });
  return tree;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findByProps({ testID }).props.onPress();
  });
}

/** The InlineError's sentence under `testID`, or null when none renders. */
function errorAt(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): string | null {
  const found = tree.root.findAllByProps({ testID });
  return found.length === 0 ? null : (found[0].props.message as string);
}

function textAt(tree: ReactTestRenderer.ReactTestRenderer, testID: string): string {
  const children = tree.root.findByProps({ testID }).props.children as unknown;
  return Array.isArray(children) ? children.join('') : String(children);
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('the scan side says what actually failed', () => {
  it('a camera that would not open', async () => {
    jest.spyOn(qr, 'readIdFromCamera').mockRejectedValue(new qr.QrImageUnreadable('camera'));
    const tree = await render();
    await press(tree, 'link-scan-camera');
    expect(errorAt(tree, 'link-scan-error')).toBe(LINKING_COPY.cameraFailed);
  });

  it('a cancelled camera scan is not an error', async () => {
    jest.spyOn(qr, 'readIdFromCamera').mockRejectedValue(new qr.QrNoCode());
    const tree = await render();
    await press(tree, 'link-scan-camera');
    expect(errorAt(tree, 'link-scan-error')).toBeNull();
    expect(tree.root.findAllByProps({ testID: 'link-scan-camera' }).length).toBeGreaterThan(0);
  });

  it('a photo library the app may not read', async () => {
    jest.spyOn(media, 'pickImageFile').mockRejectedValue(new media.PickDenied('library'));
    const tree = await render();
    await press(tree, 'link-scan-photo');
    expect(errorAt(tree, 'link-scan-error')).toBe(LINKING_COPY.photosDenied);
  });

  it('a photo too large to read', async () => {
    jest.spyOn(media, 'pickImageFile').mockRejectedValue(new media.PickTooLarge());
    const tree = await render();
    await press(tree, 'link-scan-photo');
    expect(errorAt(tree, 'link-scan-error')).toBe(LINKING_COPY.photoTooBig);
  });

  it('a photo carrying more than one code', async () => {
    jest.spyOn(media, 'pickImageFile').mockResolvedValue({ uri: 'file:///code.jpg' } as never);
    jest.spyOn(qr, 'readIdFromImage').mockRejectedValue(new qr.QrAmbiguous(2));
    const tree = await render();
    await press(tree, 'link-scan-photo');
    expect(errorAt(tree, 'link-scan-error')).toBe(LINKING_COPY.qrMultiple);
  });

  it('a photo that would not decode', async () => {
    jest.spyOn(media, 'pickImageFile').mockResolvedValue({ uri: 'file:///code.jpg' } as never);
    jest.spyOn(qr, 'readIdFromImage').mockRejectedValue(new qr.QrImageUnreadable('decode'));
    const tree = await render();
    await press(tree, 'link-scan-photo');
    expect(errorAt(tree, 'link-scan-error')).toBe(LINKING_COPY.photoUnreadable);
  });

  it('a photo with no code in it', async () => {
    jest.spyOn(media, 'pickImageFile').mockResolvedValue({ uri: 'file:///code.jpg' } as never);
    jest.spyOn(qr, 'readIdFromImage').mockRejectedValue(new qr.QrNoCode());
    const tree = await render();
    await press(tree, 'link-scan-photo');
    expect(errorAt(tree, 'link-scan-error')).toBe(LINKING_COPY.photoNoCode);
  });

  it('a network that never answered the key fetch', async () => {
    jest.spyOn(qr, 'readIdFromCamera').mockResolvedValue(OTHER);
    jest
      .spyOn(OffererCeremony, 'begin')
      .mockRejectedValue(new TypeError('Network request failed'));
    const tree = await render();
    await press(tree, 'link-scan-camera');
    expect(errorAt(tree, 'link-scan-error')).toBe(LINKING_COPY.transportFailed);
  });

  it("the server's refusal of the key fetch stays the collapsed refusal", async () => {
    jest.spyOn(qr, 'readIdFromCamera').mockResolvedValue(OTHER);
    jest
      .spyOn(OffererCeremony, 'begin')
      .mockRejectedValue(new ApiRequestError('not found', 404));
    const tree = await render();
    await press(tree, 'link-scan-camera');
    expect(errorAt(tree, 'link-scan-error')).toBe(LINKING_COPY.refused);
  });

  it('a confirm the network never carried', async () => {
    jest.spyOn(qr, 'readIdFromCamera').mockResolvedValue(OTHER);
    jest.spyOn(OffererCeremony, 'begin').mockResolvedValue(
      fakeCeremony({ confirm: jest.fn().mockRejectedValue(new ApiTimeoutError(10_000)) }),
    );
    const tree = await render();
    await press(tree, 'link-scan-camera');
    await press(tree, 'link-confirm-code');
    expect(errorAt(tree, 'link-failed')).toBe(LINKING_COPY.transportFailed);
  });

  it('a confirm the server refused', async () => {
    jest.spyOn(qr, 'readIdFromCamera').mockResolvedValue(OTHER);
    jest.spyOn(OffererCeremony, 'begin').mockResolvedValue(
      fakeCeremony({
        confirm: jest.fn().mockRejectedValue(new ApiRequestError('conflict', 409, 'slot_taken')),
      }),
    );
    const tree = await render();
    await press(tree, 'link-scan-camera');
    await press(tree, 'link-confirm-code');
    expect(errorAt(tree, 'link-failed')).toBe(LINKING_COPY.refused);
    // The way back names the real order (the proof pass, 2026-10-08): the
    // ceremony starts HERE, by scanning the new device's code.
    expect(LINKING_COPY.refused).toContain('scan it from here');
    expect(LINKING_COPY.refused).not.toContain('start again from the new device');
    expect(LINKING_COPY.expired).toContain('scan it from here');
  });

  it('the link-offer budget’s 429 is its own sentence, never "expired or taken" (the proof pass, 2026-10-08)', async () => {
    jest.spyOn(qr, 'readIdFromCamera').mockResolvedValue(OTHER);
    jest.spyOn(OffererCeremony, 'begin').mockResolvedValue(
      fakeCeremony({
        confirm: jest.fn().mockRejectedValue(new ApiRequestError('rate limited', 429, 'rate_limited')),
      }),
    );
    const tree = await render();
    await press(tree, 'link-scan-camera');
    await press(tree, 'link-confirm-code');
    expect(errorAt(tree, 'link-failed')).toBe(LINKING_COPY.rateLimited);
    expect(LINKING_COPY.rateLimited).toMatch(/too many link attempts/i);
    expect(LINKING_COPY.rateLimited).not.toContain('expired');
  });
});

describe('the waiting phase', () => {
  it("counts down from the offer's own expiry, states the mismatch outcome, and stops on request", async () => {
    jest.useFakeTimers({ now: NOW_MS });
    const ceremony = fakeCeremony();
    jest.spyOn(qr, 'readIdFromCamera').mockResolvedValue(OTHER);
    jest.spyOn(OffererCeremony, 'begin').mockResolvedValue(ceremony);
    const tree = await render();
    await press(tree, 'link-scan-camera');
    await press(tree, 'link-confirm-code');

    expect(textAt(tree, 'link-expires')).toBe(LINKING_COPY.expiresIn('10:00'));
    expect(JSON.stringify(tree.toJSON())).toContain(LINKING_COPY.mismatchHint);

    // Five seconds of real time (fake timers move the wall clock with them):
    // the clock is live, and no probe has fired yet (the first is at 15 s).
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    expect(textAt(tree, 'link-expires')).toBe(LINKING_COPY.expiresIn('9:55'));
    expect(ceremony.checkLinked).not.toHaveBeenCalled();

    await press(tree, 'link-stop-waiting');
    expect(ceremony.cancel).toHaveBeenCalledTimes(1);
    // Back at the start — and a stopped screen spends no more prekeys.
    expect(tree.root.findAllByProps({ testID: 'link-scan-camera' }).length).toBeGreaterThan(0);
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(120_000);
    });
    expect(ceremony.checkLinked).not.toHaveBeenCalled();
  });

  it('an offer that ran out is said as an expiry, not as a refusal', async () => {
    jest.useFakeTimers({ now: NOW_MS });
    const ceremony = fakeCeremony({
      checkLinked: jest.fn(async () => {
        (ceremony as unknown as { phase: string }).phase = 'failed';
        return false;
      }),
    });
    jest.spyOn(qr, 'readIdFromCamera').mockResolvedValue(OTHER);
    jest.spyOn(OffererCeremony, 'begin').mockResolvedValue(ceremony);
    const tree = await render();
    await press(tree, 'link-scan-camera');
    await press(tree, 'link-confirm-code');
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    expect(errorAt(tree, 'link-failed')).toBe(LINKING_COPY.expired);
  });
});
