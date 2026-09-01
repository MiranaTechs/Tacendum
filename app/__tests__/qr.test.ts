/**
 * An id read out of a picture addresses an account that no directory can
 * confirm. Nobody checks the name, nobody bounces the message, and a chat
 * with the wrong person looks exactly like a chat with the right one until
 * somebody says something they shouldn't. Every tolerance asserted here is
 * the difference between those two outcomes — which is why a decoded payload
 * is treated as hostile text and why more than one code is a refusal rather
 * than a choice.
 */

import { extractId } from '../src/peerId';
import {
  MAX_PAYLOAD_CHARS,
  QR_PIXELS,
  QrAmbiguous,
  QrEncodeFailed,
  QrImageUnreadable,
  QrNoCode,
  QrNotAnId,
  QrOwnId,
  QrShareFailed,
  clearShareImage,
  encodeSelfQr,
  readIdFromCamera,
  readIdFromImage,
  selfPayload,
  writeShareImage,
} from '../src/qr';

/**
 * Reading a QR must produce a string and nothing else — no prekey fetch, no
 * identity lookup, no "hello". These factories only run if something in the
 * import graph of `../src/qr` reaches for them, so a count above zero IS the
 * violation. (Named `mock…` because babel-plugin-jest-hoist lifts jest.mock
 * above the imports and only permits out-of-scope names with that prefix.)
 */
const mockNetworkTouches = {
  api: 0,
  ws: 0,
  messaging: 0,
  registration: 0,
  db: 0,
};
jest.mock('../src/api', () => {
  mockNetworkTouches.api += 1;
  return {};
});
jest.mock('../src/ws', () => {
  mockNetworkTouches.ws += 1;
  return {};
});
jest.mock('../src/messaging', () => {
  mockNetworkTouches.messaging += 1;
  return {};
});
jest.mock('../src/registration', () => {
  mockNetworkTouches.registration += 1;
  return {};
});
jest.mock('../src/db', () => {
  mockNetworkTouches.db += 1;
  return {};
});

/** The native module — CoreImage and Vision are only provable on a device
 * (see the device-verification round trip), so tests drive what the encoder returns
 * and what the decoder finds through __qr. */
const nativeQr = jest.requireMock('tacendum-qr') as {
  encodePng: jest.Mock;
  decodeFile: jest.Mock;
  scanWithCamera: jest.Mock;
  writeSharePng: jest.Mock;
  clearSharePng: jest.Mock;
  __qr: {
    state: {
      pngB64: string;
      shareUri: string;
      payloads: string[];
      failEncode: string | null;
      failDecode: string | null;
      failScan: string | null;
      failWrite: string | null;
    };
    calls: { cleared: number };
    reset: () => void;
  };
};

beforeEach(() => {
  nativeQr.__qr.reset();
  nativeQr.encodePng.mockClear();
  nativeQr.decodeFile.mockClear();
  nativeQr.writeSharePng.mockClear();
  nativeQr.clearSharePng.mockClear();
});

/** Mine. */
const SELF_ID = '01HZZ0N5SY1AD4Q6P7RTVWM9FG';
/** Theirs — the one that should come out of the picture. */
const ID = '01HZX8K3QW9YB2N4M5PRTVJ7CD';
/** A third account, for the ambiguity case. */
const OTHER_ID = '01HZY9M4RX0ZC3P5N6QSTVK8DE';

const INK = { darkHex: '#121A15', lightHex: '#FAFCF7' };
const FILE = 'file:///tmp/photo.heic';

describe('selfPayload', () => {
  test('is the bare id — no scheme, no prefix, no URL', () => {
    expect(selfPayload(ID)).toBe(ID);
    expect(selfPayload(ID)).not.toMatch(/[:/]/);
    expect(selfPayload(ID)).toHaveLength(26);
  });

  test('canonicalises what the caller handed over rather than trusting it', () => {
    expect(selfPayload('01hz x8k3 qw9y b2n4 m5pr tvj7 cd')).toBe(ID);
  });

  test('refuses to draw a string that is not an id', () => {
    expect(() => selfPayload('hello there')).toThrow(QrEncodeFailed);
    expect(() => selfPayload('')).toThrow(QrEncodeFailed);
  });
});

describe('encodeSelfQr', () => {
  test('hands the native encoder the bare id and the ink it was given', async () => {
    await encodeSelfQr(ID, INK);
    const [text, pixels, darkHex, lightHex] = nativeQr.encodePng.mock.calls[0];
    expect(text).toBe(ID);
    expect(text).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
    expect(text).not.toMatch(/tacendum|http|:|\/\//i);
    expect(pixels).toBe(QR_PIXELS);
    expect(darkHex).toBe(INK.darkHex);
    expect(lightHex).toBe(INK.lightHex);
  });

  test('returns the bytes and the same bytes as a data URI that never hits disk', async () => {
    const drawn = await encodeSelfQr(ID, INK);
    expect(drawn.pngB64).toBe(nativeQr.__qr.state.pngB64);
    expect(drawn.dataUri).toBe(`data:image/png;base64,${drawn.pngB64}`);
    expect(nativeQr.writeSharePng).not.toHaveBeenCalled();
  });

  test('honours an explicit edge', async () => {
    await encodeSelfQr(ID, { ...INK, pixels: 512 });
    expect(nativeQr.encodePng.mock.calls[0][1]).toBe(512);
  });

  test('refuses a non-id without going near the encoder', async () => {
    await expect(encodeSelfQr('not an id', INK)).rejects.toBeInstanceOf(
      QrEncodeFailed,
    );
    expect(nativeQr.encodePng).not.toHaveBeenCalled();
  });

  test('turns any native failure into one class the screen can speak to', async () => {
    nativeQr.__qr.state.failEncode = 'qr_encode_failed';
    await expect(encodeSelfQr(ID, INK)).rejects.toBeInstanceOf(QrEncodeFailed);
  });

  test('treats an empty PNG as a failure, not as a picture', async () => {
    nativeQr.__qr.state.pngB64 = '';
    await expect(encodeSelfQr(ID, INK)).rejects.toBeInstanceOf(QrEncodeFailed);
  });

  test('a build without the QR module fails as a drawing failure', async () => {
    // The facade throws QrUnavailable SYNCHRONOUSLY when the binary predates
    // the pod. A `.catch()` on the returned promise would sail straight past
    // it and take the whole screen down.
    nativeQr.encodePng.mockImplementationOnce(() => {
      throw new Error('tacendum-qr is not in this build');
    });
    await expect(encodeSelfQr(ID, INK)).rejects.toBeInstanceOf(QrEncodeFailed);
  });
});

describe('the share file', () => {
  test('writeShareImage returns the native file URI', async () => {
    await expect(writeShareImage('iVBORw0KGgo=')).resolves.toBe(
      nativeQr.__qr.state.shareUri,
    );
    expect(nativeQr.writeSharePng).toHaveBeenCalledWith('iVBORw0KGgo=');
  });

  test('a failed write is QrShareFailed', async () => {
    nativeQr.__qr.state.failWrite = 'qr_write_failed';
    await expect(writeShareImage('iVBORw0KGgo=')).rejects.toBeInstanceOf(
      QrShareFailed,
    );
  });

  test('a synchronous native throw is still QrShareFailed', async () => {
    nativeQr.writeSharePng.mockImplementationOnce(() => {
      throw new Error('tacendum-qr is not in this build');
    });
    await expect(writeShareImage('iVBORw0KGgo=')).rejects.toBeInstanceOf(
      QrShareFailed,
    );
  });

  test('clearShareImage swallows a native rejection — tidying up is not an error', async () => {
    nativeQr.clearSharePng.mockRejectedValueOnce(new Error('gone'));
    await expect(clearShareImage()).resolves.toBeUndefined();
    await expect(clearShareImage()).resolves.toBeUndefined();
    expect(nativeQr.__qr.calls.cleared).toBe(1);
  });
});

describe('readIdFromImage — the one id in that picture', () => {
  test('returns the id in a picture with a single code', async () => {
    nativeQr.__qr.state.payloads = [ID];
    await expect(readIdFromImage(FILE, SELF_ID)).resolves.toBe(ID);
    expect(nativeQr.decodeFile).toHaveBeenCalledWith(FILE);
  });

  test('tolerates the whitespace a decoder leaves around a payload', async () => {
    nativeQr.__qr.state.payloads = [`  ${ID}\n`];
    await expect(readIdFromImage(FILE, SELF_ID)).resolves.toBe(ID);
  });

  test('tolerates an id someone wrapped in a sentence before printing it', async () => {
    nativeQr.__qr.state.payloads = [`My Tacendum ID is ${ID}`];
    await expect(readIdFromImage(FILE, SELF_ID)).resolves.toBe(ID);
  });

  test('one symbol reported twice is not ambiguity', async () => {
    nativeQr.__qr.state.payloads = [ID, ID, ` ${ID} `];
    await expect(readIdFromImage(FILE, SELF_ID)).resolves.toBe(ID);
  });

  test('no code in the picture is a refusal, not a crash', async () => {
    nativeQr.__qr.state.payloads = [];
    await expect(readIdFromImage(FILE, SELF_ID)).rejects.toBeInstanceOf(
      QrNoCode,
    );
  });

  test('codes that are only whitespace count as no code at all', async () => {
    nativeQr.__qr.state.payloads = ['', '   ', '\n'];
    await expect(readIdFromImage(FILE, SELF_ID)).rejects.toBeInstanceOf(
      QrNoCode,
    );
  });

  test('two codes are refused before either is even read', async () => {
    nativeQr.__qr.state.payloads = [ID, OTHER_ID];
    // Not `.resolves` with a value we then check: the point is that no id is
    // ever produced. Picking [0] would silently address the first person.
    const caught = await readIdFromImage(FILE, SELF_ID).then(
      value => ({ value }),
      (err: unknown) => ({ err }),
    );
    expect(caught).not.toHaveProperty('value');
    expect((caught as { err: unknown }).err).toBeInstanceOf(QrAmbiguous);
    expect((caught as { err: QrAmbiguous }).err.count).toBe(2);
  });

  test('a valid id next to a stranger’s code is still a refusal', async () => {
    nativeQr.__qr.state.payloads = [ID, 'https://example.com/promo'];
    await expect(readIdFromImage(FILE, SELF_ID)).rejects.toBeInstanceOf(
      QrAmbiguous,
    );
  });

  test('your own code is named as yours, not started as a chat', async () => {
    nativeQr.__qr.state.payloads = [SELF_ID];
    await expect(readIdFromImage(FILE, SELF_ID)).rejects.toBeInstanceOf(
      QrOwnId,
    );
  });

  test('an unreadable or absurd image is QrImageUnreadable', async () => {
    nativeQr.__qr.state.failDecode = 'qr_unreadable';
    await expect(readIdFromImage(FILE, SELF_ID)).rejects.toBeInstanceOf(
      QrImageUnreadable,
    );

    nativeQr.__qr.reset();
    nativeQr.__qr.state.failDecode = 'qr_too_large';
    await expect(readIdFromImage(FILE, SELF_ID)).rejects.toBeInstanceOf(
      QrImageUnreadable,
    );
  });

  test('a build without the QR module reads as an unreadable picture', async () => {
    nativeQr.decodeFile.mockImplementationOnce(() => {
      throw new Error('tacendum-qr is not in this build');
    });
    await expect(readIdFromImage(FILE, SELF_ID)).rejects.toBeInstanceOf(
      QrImageUnreadable,
    );
  });

  test('clearShareImage is never called as a side effect of reading', async () => {
    nativeQr.__qr.state.payloads = [ID];
    await readIdFromImage(FILE, SELF_ID);
    expect(nativeQr.__qr.calls.cleared).toBe(0);
    expect(nativeQr.encodePng).not.toHaveBeenCalled();
    expect(nativeQr.writeSharePng).not.toHaveBeenCalled();
  });
});

describe('readIdFromImage — somebody else’s QR', () => {
  /**
   * `extractId` finds a 26-character Crockford run ANYWHERE in a string, and
   * folds O→0 and I/L→1 on the way. Every payload below therefore contains
   * what extractId would happily call an id; only the guards in front of it
   * stop a Wi-Fi password or a URL slug from becoming a stranger's account.
   */
  const WIFI = 'WIFI:S:h;T:WPA;P:0123456789ABCDEFGHJKMNPQRS;;';
  const LINK = `https://example.com/${ID}`;
  const LONG = 'x'.repeat(200);

  test('the fixtures are genuinely dangerous — extractId accepts all of them', () => {
    expect(extractId(WIFI)).not.toBeNull();
    expect(extractId(LINK)).toBe(ID);
    expect(extractId(LONG)).not.toBeNull();
    // …and the WIFI one is short enough that only the URI guard can refuse it.
    expect(WIFI.length).toBeLessThanOrEqual(MAX_PAYLOAD_CHARS);
    expect(LINK.length).toBeLessThanOrEqual(MAX_PAYLOAD_CHARS);
  });

  test('a Wi-Fi code whose password contains an id-shaped run is refused', async () => {
    nativeQr.__qr.state.payloads = [WIFI];
    await expect(readIdFromImage(FILE, SELF_ID)).rejects.toBeInstanceOf(
      QrNotAnId,
    );
  });

  test('a link carrying the id is refused — the payload is never a URL', async () => {
    nativeQr.__qr.state.payloads = [LINK];
    await expect(readIdFromImage(FILE, SELF_ID)).rejects.toBeInstanceOf(
      QrNotAnId,
    );
  });

  test('other URI schemes are refused by shape, not by a list', async () => {
    for (const payload of [
      `mailto:someone@example.com?id=${ID}`,
      `otpauth://totp/x?secret=${ID}`,
      `tacendum:${ID}`,
      `TEL:${ID}`,
    ]) {
      nativeQr.__qr.reset();
      nativeQr.__qr.state.payloads = [payload];
      await expect(readIdFromImage(FILE, SELF_ID)).rejects.toBeInstanceOf(
        QrNotAnId,
      );
    }
  });

  test('a payload longer than a Tacendum QR could be is refused', async () => {
    nativeQr.__qr.state.payloads = [LONG];
    await expect(readIdFromImage(FILE, SELF_ID)).rejects.toBeInstanceOf(
      QrNotAnId,
    );
  });

  test('a code with no id in it at all is refused', async () => {
    nativeQr.__qr.state.payloads = ['BEGIN:VCARD'];
    await expect(readIdFromImage(FILE, SELF_ID)).rejects.toBeInstanceOf(
      QrNotAnId,
    );
  });

  test('a misread U is refused rather than guessed into a different account', async () => {
    // U is the one confusable character extractId will not fold, because
    // folding it to V produces a DIFFERENT valid id. That rule has to survive
    // the picture path, where the misread comes from Vision rather than a
    // human.
    for (const payload of [
      `${ID.slice(0, 25)}U`,
      `${ID.slice(0, 25)}u`,
      ID.replace('V', 'U'),
    ]) {
      nativeQr.__qr.reset();
      nativeQr.__qr.state.payloads = [payload];
      await expect(readIdFromImage(FILE, SELF_ID)).rejects.toBeInstanceOf(
        QrNotAnId,
      );
    }
  });

  test('an id one character short is refused', async () => {
    nativeQr.__qr.state.payloads = [ID.slice(0, 25)];
    await expect(readIdFromImage(FILE, SELF_ID)).rejects.toBeInstanceOf(
      QrNotAnId,
    );
  });
});

describe('network silence', () => {
  test('nothing in the read path reaches the network or the database', () => {
    expect(mockNetworkTouches).toEqual({
      api: 0,
      ws: 0,
      messaging: 0,
      registration: 0,
      db: 0,
    });
  });

  test('qr.ts imports the native facade and the id validator, and nothing else', () => {
    // Read the file rather than inspect the module registry: this is the only
    // form that also proves the absences the runtime counters cannot see —
    // no `react-native`, no `./theme`, no `./session` duress branch.
    // (`fs`/`__dirname` are untyped here; app/tsconfig.json declares only the
    // jest types, so both come in through jest's own typed helpers.)
    const fs = jest.requireActual<{
      readFileSync(path: string, encoding: string): string;
    }>('fs');
    const testPath = expect.getState().testPath ?? '';
    const root = testPath.slice(0, testPath.lastIndexOf('/__tests__/'));
    const source = fs.readFileSync(`${root}/src/qr.ts`, 'utf8');
    const specifiers = source
      .split('\n')
      .filter(line => /^import\b/.test(line))
      .map(line => /from '([^']+)';/.exec(line)?.[1]);
    expect(new Set(specifiers)).toEqual(new Set(['tacendum-qr', './peerId']));
    // No lazy escape hatch either.
    expect(source).not.toMatch(/require\(/);
    expect(source).not.toMatch(/\bfetch\(/);
  });
});

/**
 * The live camera path (V8 pairing).
 *
 * These assert the property that makes the feature safe to have at all: the
 * camera is a different way to OBTAIN payloads, not a different set of rules
 * for judging them. Every refusal below is inherited from `idFromPayloads`,
 * and the test exists so a future change to one path cannot quietly diverge
 * from the other.
 */
describe('reading an id from the camera', () => {
  // No I, L, O or U: `extractId` folds L->1 and O->0, so an id containing one
  // is not its own canonical form and would not compare equal to itself. That
  // is the fold working, and it cost this test one failure to notice.
  const SELF = '01ZZZ3NDEKTSV4RRFFQ69G5FAB';
  const THEIRS = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

  beforeEach(() => {
    nativeQr.__qr.state.payloads = [];
    nativeQr.__qr.state.failScan = null;
  });

  it('reads a single code', async () => {
    nativeQr.__qr.state.payloads = [THEIRS];
    await expect(readIdFromCamera(SELF)).resolves.toBe(THEIRS);
  });

  it('REFUSES two codes in frame rather than picking one', async () => {
    // The reason the native side reports an array. A scanner that returned
    // its first symbol would make this unreachable — the choice would already
    // have been made, by whichever code AVFoundation happened to list first,
    // and the person would silently address the wrong stranger.
    nativeQr.__qr.state.payloads = [THEIRS, '01BRZ3NDEKTSV4RRFFQ69G5FAV'];
    await expect(readIdFromCamera(SELF)).rejects.toBeInstanceOf(QrAmbiguous);
  });

  it('collapses a doubled read of ONE code, which is not ambiguity', async () => {
    nativeQr.__qr.state.payloads = [THEIRS, THEIRS];
    await expect(readIdFromCamera(SELF)).resolves.toBe(THEIRS);
  });

  it('refuses a URI-shaped payload even when it contains a valid id', async () => {
    nativeQr.__qr.state.payloads = [`https://example.com/${THEIRS}`];
    await expect(readIdFromCamera(SELF)).rejects.toBeInstanceOf(QrNotAnId);
  });

  it('refuses your own id', async () => {
    nativeQr.__qr.state.payloads = [SELF];
    await expect(readIdFromCamera(SELF)).rejects.toBeInstanceOf(QrOwnId);
  });

  it('treats a cancelled scan as no code, not as a failure', async () => {
    // Native resolves with an empty array on cancel, no camera, and denied
    // permission alike — none of those is an error, and the screen stays put.
    nativeQr.__qr.state.payloads = [];
    await expect(readIdFromCamera(SELF)).rejects.toBeInstanceOf(QrNoCode);
  });

  it('surfaces a broken scanner as unreadable', async () => {
    nativeQr.__qr.state.failScan = 'camera exploded';
    await expect(readIdFromCamera(SELF)).rejects.toBeInstanceOf(QrImageUnreadable);
  });
});
