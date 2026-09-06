/**
 * The send-failure classifier, tested DIRECTLY for the first time. Until now the only way to ask it a question was to
 * mount a thread and make a send fail.
 *
 * THE RULE IT EXISTS TO KEEP: a raw exception never reaches the
 * screen. Every answer is a sentence from the deck the caller hands in, and
 * a native reason is read from `code` — matching only on a thrown message
 * once reported a first-ever permission denial as a connection problem, and
 * sent the person somewhere they could not fix it.
 *
 * Falsifier (CONTRIBUTING.md:76-80): run against a deliberately broken arm
 * before it was believed — see the commit body.
 */
import { PickDenied, PickUnavailable } from '../src/media';
import { sendErrorFor, type SendErrorCopy } from '../src/thread/errors';

/** A stand-in deck: every key its own recognisable sentence, so a wrong arm
 * cannot pass by accident the way twenty copies of 'Try again' would. */
const COPY: SendErrorCopy = {
  cameraDenied: 'copy:cameraDenied',
  libraryDenied: 'copy:libraryDenied',
  cameraUnavailable: 'copy:cameraUnavailable',
  safetyBlocked: 'copy:safetyBlocked',
  noAccount: 'copy:noAccount',
  fileTooLarge: 'copy:fileTooLarge',
  photoTooLarge: 'copy:photoTooLarge',
  tooLong: 'copy:tooLong',
  micDenied: 'copy:micDenied',
  micBusyCall: 'copy:micBusyCall',
  locationDenied: 'copy:locationDenied',
  photoUnreadable: 'copy:photoUnreadable',
  photoFailed: 'copy:photoFailed',
  fileFailed: 'copy:fileFailed',
  voiceFailed: 'copy:voiceFailed',
  locationFailed: 'copy:locationFailed',
  reactionFailed: 'copy:reactionFailed',
  editFailed: 'copy:editFailed',
  deleteFailed: 'copy:deleteFailed',
  sendFailed: 'copy:sendFailed',
};

/** A TurboModule rejection: the reason is on `code`, not in the sentence. */
const rejected = (code: string, message = 'native said something'): Error => {
  const err = new Error(message);
  (err as unknown as { code: string }).code = code;
  return err;
};

describe('a permission problem is named as one, not as a connection problem', () => {
  test('the camera and the library get their own sentence, each offering Settings', () => {
    expect(sendErrorFor(new PickDenied('camera'), 'photo', COPY)).toEqual({
      message: 'copy:cameraDenied',
      settings: true,
    });
    expect(sendErrorFor(new PickDenied('library'), 'photo', COPY)).toEqual({
      message: 'copy:libraryDenied',
      settings: true,
    });
  });

  test('a microphone denial offers Settings; a busy call does not', () => {
    expect(sendErrorFor(rejected('denied'), 'voice', COPY)).toEqual({
      message: 'copy:micDenied',
      settings: true,
    });
    expect(sendErrorFor(rejected('call_active'), 'voice', COPY)).toEqual({
      message: 'copy:micBusyCall',
      settings: false,
    });
  });

  test('a location denial offers Settings', () => {
    expect(sendErrorFor(rejected('denied'), 'location', COPY)).toEqual({
      message: 'copy:locationDenied',
      settings: true,
    });
  });

  test('no camera on this device is not a permission the person can grant', () => {
    expect(sendErrorFor(new PickUnavailable(), 'photo', COPY)).toEqual({
      message: 'copy:cameraUnavailable',
      settings: false,
    });
  });
});

describe('a size refusal is read from the code, per kind', () => {
  test('the native `too_large` code splits three ways', () => {
    expect(sendErrorFor(rejected('too_large'), 'file', COPY).message).toBe(
      'copy:fileTooLarge',
    );
    expect(sendErrorFor(rejected('too_large'), 'photo', COPY).message).toBe(
      'copy:photoTooLarge',
    );
    expect(sendErrorFor(rejected('too_large'), 'text', COPY).message).toBe(
      'copy:tooLong',
    );
  });
});

describe('the three refusals the send path itself raises keep their sentence', () => {
  test('a safety-number change stops everything until it is reviewed', () => {
    expect(
      sendErrorFor(new Error('safety number changed'), 'text', COPY).message,
    ).toBe('copy:safetyBlocked');
  });

  test('no account for this id says so', () => {
    expect(
      sendErrorFor(new Error('no account for this id'), 'text', COPY).message,
    ).toBe('copy:noAccount');
  });

  test('an unreadable photo asks for another one, and outranks the kind fallback', () => {
    expect(
      sendErrorFor(new Error('photo unreadable'), 'photo', COPY).message,
    ).toBe('copy:photoUnreadable');
  });
});

describe('every kind has a sentence of its own when nothing classifies', () => {
  test.each([
    ['text', 'copy:sendFailed'],
    ['photo', 'copy:photoFailed'],
    ['file', 'copy:fileFailed'],
    ['voice', 'copy:voiceFailed'],
    ['location', 'copy:locationFailed'],
    ['reaction', 'copy:reactionFailed'],
    ['edit', 'copy:editFailed'],
    ['delete', 'copy:deleteFailed'],
  ] as const)('%s falls back to %s', (kind, expected) => {
    expect(sendErrorFor(new Error('boom'), kind, COPY).message).toBe(expected);
    expect(sendErrorFor(new Error('boom'), kind, COPY).settings).toBe(false);
  });

  test('a thrown non-Error is still a sentence, never a cast', () => {
    expect(sendErrorFor('a string', 'text', COPY)).toEqual({
      message: 'copy:sendFailed',
      settings: false,
    });
    expect(sendErrorFor(undefined, 'text', COPY).message).toBe(
      'copy:sendFailed',
    );
  });
});

describe('the raw exception never reaches the screen', () => {
  test('a message carrying what looks like a payload comes back as fixed copy', () => {
    // The failure mode this rule exists for: a thrown string with the
    // message body in it must not be echoed onto glass.
    const leaky = new Error('failed to send: "meet me at the back gate at 9"');
    const out = sendErrorFor(leaky, 'text', COPY);
    expect(out.message).toBe('copy:sendFailed');
    expect(out.message).not.toContain('back gate');
  });

  test('every answer is a value from the deck it was handed', () => {
    const deckValues = new Set(Object.values(COPY));
    const cases: unknown[] = [
      new PickDenied('camera'),
      new PickDenied('library'),
      new PickUnavailable(),
      rejected('too_large'),
      rejected('denied'),
      rejected('call_active'),
      new Error('safety number changed'),
      new Error('no account for this id'),
      new Error('photo unreadable'),
      new Error('anything else at all'),
      'not an error',
    ];
    const kinds = [
      'text',
      'photo',
      'file',
      'voice',
      'location',
      'reaction',
      'edit',
      'delete',
    ] as const;
    for (const err of cases) {
      for (const kind of kinds) {
        expect(deckValues.has(sendErrorFor(err, kind, COPY).message)).toBe(true);
      }
    }
  });
});
