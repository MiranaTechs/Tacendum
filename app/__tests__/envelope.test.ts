import { MAX_PAYLOAD_B64_LENGTH } from '@tacendum/shared';

import {
  EnvelopeRefusedError,
  UNSUPPORTED_TEXT,
  VAULT_BODY_MAX,
  VAULT_TITLE_MAX,
  displayText,
  encodeEnvelope,
  isCarrierEnvelope,
  parseEnvelope,
  previewFor,
} from '../src/envelope';

/**
 * The envelope protocol is the app's private in-band signalling: it rides
 * inside Signal ciphertext, so a parsing mistake here is a rendering or
 * state-corruption bug that no server test can catch.
 */

const IMAGE = {
  tcm: 'image' as const,
  att: 'a'.repeat(43),
  key: 'k'.repeat(44),
  w: 480,
  h: 360,
};
const REACT = { tcm: 'react' as const, ref: '01ABC', ofs: true, emoji: '❤️' };
const SHOT = { tcm: 'shot' as const };
const EDIT = { tcm: 'edit' as const, ref: '01ABC', text: 'meant tomorrow' };
const DEL = { tcm: 'del' as const, ref: '01ABC' };
const REPLY = {
  tcm: 'reply' as const,
  ref: '01ABC',
  ofs: false,
  text: 'yes, that one',
};
const PROFILE = {
  tcm: 'profile' as const,
  n: 'Maya',
  a: 'in the garden',
  v: 7,
};
const TIMER = { tcm: 'timer' as const, s: 3600, v: 7 };
const TIMER_OFF = { tcm: 'timer' as const, s: 0, v: 8 };

describe('envelope round trip', () => {
  it('encodes and parses each envelope kind losslessly', () => {
    for (const envelope of [IMAGE, REACT, PROFILE, SHOT, EDIT, DEL, REPLY]) {
      expect(parseEnvelope(encodeEnvelope(envelope))).toEqual(envelope);
    }
  });

  it('carries an optional avatar pointer on a profile card', () => {
    const withAvatar = { ...PROFILE, att: IMAGE.att, key: IMAGE.key };
    expect(parseEnvelope(encodeEnvelope(withAvatar))).toEqual(withAvatar);
  });

  it('carries bounded AI notification requests and acknowledgements on profile cards', () => {
    const withPreference = {
      ...PROFILE,
      notifyPref: {
        q: '01J8MEAPPR0VAQ4X2C6TKN9RFW',
        routine: 'quiet' as const,
      },
      notifyPrefAck: {
        q: '01J8MEAPPR0VAQ4X2C6TKN9RFX',
        routine: 'all' as const,
      },
    };
    expect(parseEnvelope(encodeEnvelope(withPreference))).toEqual(withPreference);
  });

  it('drops only malformed AI notification metadata from an otherwise valid profile', () => {
    expect(
      parseEnvelope(
        JSON.stringify({
          ...PROFILE,
          notifyPrefAck: { q: 'not-a-ulid', routine: 'silent' },
        }),
      ),
    ).toEqual(PROFILE);
  });
});

describe('envelope parsing is strict', () => {
  it('treats ordinary text as text, including JSON-looking text', () => {
    for (const body of [
      'hello',
      '',
      '{}',
      '{"hello":"world"}',
      '[1,2,3]',
      'not json at all {"tcm":"image"}',
    ]) {
      expect(parseEnvelope(body)).toBeNull();
    }
  });

  it('rejects malformed or unknown envelopes rather than half-applying them', () => {
    for (const body of [
      '{"tcm":"image"}', // no pointer
      '{"tcm":"image","att":"x","key":"y","w":0,"h":10}', // zero dimension
      '{"tcm":"image","att":"x","key":"y","w":-1,"h":10}', // negative
      '{"tcm":"react","ref":"1","emoji":"x"}', // missing authorship bit
      '{"tcm":"react","ref":"","ofs":true,"emoji":"x"}', // empty target
      '{"tcm":"profile","n":"a","a":"b"}', // missing version
      '{"tcm":"profile","n":"a","a":"b","v":-1}', // negative version
      '{"tcm":"unknown","x":1}',
      '{"tcm":"image","att":"x","key":"y","w":1,"h":1', // truncated json
      '{"tcm":"edit","ref":"1"}', // no replacement text
      '{"tcm":"edit","ref":"1","text":""}', // an empty edit is a delete
      '{"tcm":"edit","ref":"","text":"x"}', // no target
      '{"tcm":"del"}', // no target
      '{"tcm":"del","ref":""}',
      '{"tcm":"reply","ref":"1","text":"x"}', // missing authorship bit
      '{"tcm":"reply","ref":"1","ofs":true,"text":""}', // empty reply
      '{"tcm":"reply","ref":"","ofs":true,"text":"x"}',
    ]) {
      expect(parseEnvelope(body)).toBeNull();
    }
  });

  it('refuses replacement text that is itself an envelope', () => {
    // An edit's text is stored AS a message body, and every reader re-parses
    // a body that starts with the sentinel. Without this, a peer could edit
    // their own message into a carrier and have the row silently filtered out
    // of the thread — a deletion with no tombstone and no Edited marker.
    const carrier = '{"tcm":"react","ref":"x","ofs":true,"emoji":"x"}';
    expect(
      parseEnvelope(JSON.stringify({ tcm: 'edit', ref: '01A', text: carrier })),
    ).toBeNull();
    expect(
      parseEnvelope(
        JSON.stringify({ tcm: 'reply', ref: '01A', ofs: false, text: carrier }),
      ),
    ).toBeNull();
  });

  it('still allows text that merely mentions the sentinel mid-sentence', () => {
    // The guard is about what a body PARSES as, not about the characters.
    const chatty = 'the format is {"tcm":"image"} apparently';
    const edit = { tcm: 'edit' as const, ref: '01A', text: chatty };
    expect(parseEnvelope(JSON.stringify(edit))).toEqual(edit);
  });

  it('refuses an edit that claims authorship — you may only edit your own', () => {
    // No `ofs` bit exists by design: the receiver always applies an edit to
    // the SENDER's message. A crafted bit must not smuggle one in.
    const forged = parseEnvelope(
      '{"tcm":"edit","ref":"01ABC","text":"x","ofs":true}',
    );
    expect(forged).toEqual({ tcm: 'edit', ref: '01ABC', text: 'x' });
  });

  it('bounds the fields a peer controls', () => {
    const longName = { ...PROFILE, n: 'x'.repeat(41) };
    const longAbout = { ...PROFILE, a: 'x'.repeat(141) };
    const longEmoji = { ...REACT, emoji: 'x'.repeat(17) };
    for (const envelope of [longName, longAbout, longEmoji]) {
      expect(parseEnvelope(JSON.stringify(envelope))).toBeNull();
    }
  });
});

describe('conversation vs transport', () => {
  it('classifies reactions and profile cards as carriers, never content', () => {
    expect(isCarrierEnvelope(encodeEnvelope(REACT))).toBe(true);
    expect(isCarrierEnvelope(encodeEnvelope(PROFILE))).toBe(true);
    expect(isCarrierEnvelope(encodeEnvelope(IMAGE))).toBe(false);
    expect(isCarrierEnvelope('hello')).toBe(false);
  });

  it('classifies a screenshot notice as conversation, not transport', () => {
    expect(isCarrierEnvelope(encodeEnvelope(SHOT))).toBe(false);
  });

  it('classifies edits and deletions as transport — they mutate a row, not add one', () => {
    expect(isCarrierEnvelope(encodeEnvelope(EDIT))).toBe(true);
    expect(isCarrierEnvelope(encodeEnvelope(DEL))).toBe(true);
  });

  it('classifies a reply as conversation — it IS a message', () => {
    expect(isCarrierEnvelope(encodeEnvelope(REPLY))).toBe(false);
  });

  it('previews photos by name and never leaks envelope JSON into a chat row', () => {
    expect(previewFor(encodeEnvelope(IMAGE))).toBe('Photo');
    expect(previewFor(encodeEnvelope(REACT))).toBe('');
    expect(previewFor(encodeEnvelope(PROFILE))).toBe('');
    expect(previewFor('see you soon')).toBe('see you soon');
  });

  it('previews a screenshot notice by name, never as JSON', () => {
    expect(previewFor(encodeEnvelope(SHOT))).toBe('Screenshot');
  });

  it('classifies a timer change as conversation — it is announced, not silent', () => {
    // A silently shortened timer is a trust problem,
    // so this keeps a row on both phones and must NOT be filtered out of the
    // thread the way a reaction or a profile card is.
    expect(isCarrierEnvelope(encodeEnvelope(TIMER))).toBe(false);
    expect(isCarrierEnvelope(encodeEnvelope(TIMER_OFF))).toBe(false);
  });

  it('previews a timer change in words, never as JSON', () => {
    // The gap that shipped the bug: with no case here it fell through to the
    // blank-for-any-envelope line, which blanked the chat row's preview AND
    // let ChatThreadScreen's `previewFor(body) || body` fallback print the
    // envelope itself in a failed bubble.
    expect(previewFor(encodeEnvelope(TIMER))).toBe('Disappearing messages on');
    expect(previewFor(encodeEnvelope(TIMER_OFF))).toBe(
      'Disappearing messages off',
    );
    expect(previewFor(encodeEnvelope(TIMER))).not.toContain('tcm');
  });

  it('never hands a timer envelope to the clipboard or VoiceOver as text', () => {
    // displayText is the clipboard / spoken-label path; a timer row has no
    // words of its own, so it must yield nothing rather than JSON.
    expect(displayText(encodeEnvelope(TIMER))).toBe('');
  });

  it('previews a reply as its own words, and never previews a carrier', () => {
    expect(previewFor(encodeEnvelope(REPLY))).toBe('yes, that one');
    expect(previewFor(encodeEnvelope(EDIT))).toBe('');
    expect(previewFor(encodeEnvelope(DEL))).toBe('');
  });
});

/**
 * This must ship BEFORE any call envelope is ever sent, or a
 * peer running an older build renders raw JSON in a chat bubble.
 */
describe('forward compatibility with envelopes we do not understand', () => {
  const CID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

  it('never renders an unknown envelope as raw JSON', () => {
    for (const body of [
      '{"tcm":"unknown","x":1}',
      '{"tcm":"future.thing","a":"b"}',
      '{"tcm":"image","att":"x"}', // known kind, malformed — still unreadable
    ]) {
      expect(previewFor(body)).toBe(UNSUPPORTED_TEXT);
      expect(displayText(body)).toBe(UNSUPPORTED_TEXT);
      expect(previewFor(body)).not.toContain('tcm');
    }
  });

  it('still treats ordinary text as itself', () => {
    expect(previewFor('see you soon')).toBe('see you soon');
    expect(displayText('see you soon')).toBe('see you soon');
    // Text that merely mentions the format is text, not an envelope.
    const chatty = 'the format is {"tcm":"image"} apparently';
    expect(displayText(chatty)).toBe(chatty);
  });

  it('stays SILENT for call signalling it cannot parse, rather than showing a row', () => {
    // A build that predates a future call envelope must not spam the thread
    // with "unsupported" rows for what is transport, not conversation. Every
    // `call.*` body is a carrier whether or not this build can read it.
    for (const body of [
      '{"tcm":"call.future","cid":"x"}',
      '{"tcm":"call.offer","cid":"not-a-ulid"}',
      '{"tcm":"call.offer"}',
    ]) {
      expect(isCarrierEnvelope(body)).toBe(true);
      expect(previewFor(body)).toBe('');
      expect(displayText(body)).toBe('');
    }
  });

  it('treats every well-formed call envelope as transport, never as a message', () => {
    const calls = [
      { tcm: 'call.offer', cid: CID, sdp: 'v=0', vid: true, exp: 2_000_000_000_000 },
      { tcm: 'call.answer', cid: CID, sdp: 'v=0', vid: false },
      { tcm: 'call.ice', cid: CID, c: [{ cand: 'candidate:1', mid: '0', idx: 0 }] },
      { tcm: 'call.end', cid: CID, r: 'hangup' },
      { tcm: 'call.ringing', cid: CID },
      { tcm: 'call.media', cid: CID, a: true, v: false },
      { tcm: 'call.restart', cid: CID, sdp: 'v=0' },
    ];
    for (const envelope of calls) {
      const body = JSON.stringify(envelope);
      expect(parseEnvelope(body)).toEqual(envelope);
      expect(isCarrierEnvelope(body)).toBe(true);
      expect(previewFor(body)).toBe('');
      expect(displayText(body)).toBe('');
    }
  });
});

/**
 * SHARED ROOM VAULT. A vault item is an ordinary encrypted
 * message with structure inside it, so everything that turns a body into words
 * has to be checked here first — and one of those words is a door code.
 */
describe('the Shared Room Vault envelope', () => {
  const ITEM = '01WFXZ3NDEKTSV4RRFFQ69G5AB';
  const SECRET = 'HUNTER2-DOORCODE-4417';
  const VAULT_SET = {
    tcm: 'vault' as const,
    op: 'set' as const,
    id: ITEM,
    title: 'Front door',
    body: SECRET,
    n: 3,
    k: 2,
  };
  const VAULT_DEL = {
    tcm: 'vault' as const,
    op: 'del' as const,
    id: ITEM,
    n: 4,
    k: 2,
  };

  it('round-trips both operations losslessly', () => {
    expect(parseEnvelope(encodeEnvelope(VAULT_SET))).toEqual(VAULT_SET);
    expect(parseEnvelope(encodeEnvelope(VAULT_DEL))).toEqual(VAULT_DEL);
  });

  it('is NOT a carrier — a change to what the Room keeps is announced', () => {
    // The first draft said the opposite AND that a system row
    // would announce it, which contradicts: a carrier is filtered out of the
    // thread, so there would be no row left to render. Either side changing a
    // door code is a thing the other is entitled to be told about, so it keeps
    // a row on both phones exactly as a timer change does.
    expect(isCarrierEnvelope(encodeEnvelope(VAULT_SET))).toBe(false);
    expect(isCarrierEnvelope(encodeEnvelope(VAULT_DEL))).toBe(false);
  });

  it('previews in words, and the preview carries neither the value nor the title', () => {
    // previewFor's output is written to chats.lastMessageText and is what a
    // notification would show — outside the Room, outliving the item, readable
    // without opening anything. The title is itself a disclosure ("Divorce
    // lawyer login"), so it stays on the thread row and goes no further.
    expect(previewFor(encodeEnvelope(VAULT_SET))).toBe('Saved to the vault');
    expect(previewFor(encodeEnvelope(VAULT_DEL))).toBe('Removed from the vault');
    expect(previewFor(encodeEnvelope(VAULT_SET))).not.toContain(SECRET);
    expect(previewFor(encodeEnvelope(VAULT_SET))).not.toContain('Front door');
    expect(previewFor(encodeEnvelope(VAULT_SET))).not.toContain('tcm');
  });

  it('never hands a vault envelope to the clipboard or VoiceOver as text', () => {
    // displayText is the clipboard and spoken-label path. The row's body IS the
    // envelope, credential included, so '' is the only acceptable answer — and
    // it is the second of the two defences the thread relies on (the first
    // being that a vault row returns before the bubble rail exists at all).
    expect(displayText(encodeEnvelope(VAULT_SET))).toBe('');
    expect(displayText(encodeEnvelope(VAULT_DEL))).toBe('');
  });

  it('bounds the fields a peer controls, and shape-checks the id', () => {
    // Unbounded strings on a screen are a layout weapon, and an id is half a
    // primary key that reaches a testID — neither may be whatever a peer likes.
    for (const envelope of [
      { ...VAULT_SET, title: 'x'.repeat(VAULT_TITLE_MAX + 1) },
      { ...VAULT_SET, body: 'x'.repeat(VAULT_BODY_MAX + 1) },
      { ...VAULT_SET, title: '' },
      { ...VAULT_SET, body: '' },
      { ...VAULT_SET, id: 'not-a-ulid' },
      { ...VAULT_SET, id: `${ITEM}X` },
      { ...VAULT_SET, id: ITEM.toLowerCase() },
      { ...VAULT_SET, op: 'wipe' },
      { ...VAULT_SET, n: 0 }, // a counter starts at 1
      { ...VAULT_SET, n: -1 },
      { ...VAULT_SET, n: 1.5 },
      { ...VAULT_SET, k: -1 },
      { tcm: 'vault', op: 'set', id: ITEM, title: 'a', body: 'b', k: 0 }, // no n
      { tcm: 'vault', op: 'set', id: ITEM, title: 'a', body: 'b', n: 1 }, // no k
    ]) {
      expect(parseEnvelope(JSON.stringify(envelope))).toBeNull();
    }
  });

  it('carries a per-writer counter and an acknowledgement, and no clock at all', () => {
    // The amendment in one assertion. `v` was a sender wall clock, which made a
    // peer's clock a correctness input: it needed a future clamp, the clamp was
    // a silent permanent drop, and `max(now, current + 1)` then carried the bad
    // number into every later edit of that item. `n` is the writer's own
    // counter and `k` is what they had seen of mine — causality rather than
    // recency, which is the one thing a clock cannot express.
    const parsed = parseEnvelope(encodeEnvelope(VAULT_SET));
    expect(Object.keys(parsed!)).not.toContain('v');
    expect(parsed).toMatchObject({ n: 3, k: 2 });
    // `k` = 0 is a legitimate "I had seen nothing of yours", which is exactly
    // what a first write says.
    expect(parseEnvelope(encodeEnvelope({ ...VAULT_SET, k: 0 }))).toMatchObject({
      k: 0,
    });
  });

  it('carries a value big enough for the things people actually keep', () => {
    // 2048 did not fit the use case: a block of backup codes, a WireGuard
    // config or an SSH private key runs 1.7-3.4 KB. Under the old cap those
    // composed happily, sent, and arrived as "Unsupported message" — with the
    // server copy already purged and the ratchet key spent.
    const key = 'k'.repeat(VAULT_BODY_MAX);
    expect(parseEnvelope(encodeEnvelope({ ...VAULT_SET, body: key }))).toMatchObject(
      { body: key },
    );
    // And still bounded: one frame, one ratchet message, one server payload cap.
    expect(VAULT_BODY_MAX).toBeLessThan(MAX_PAYLOAD_B64_LENGTH / 2);
  });

  it('refuses a title or a value that is itself an envelope', () => {
    // The title is DRAWN into a thread row, and a string beginning with the
    // sentinel reads as structure everywhere in this app. Same reasoning as an
    // edit's replacement text: a peer must not be able to put a forged-looking
    // envelope in front of someone.
    const carrier = '{"tcm":"react","ref":"x","ofs":true,"emoji":"x"}';
    expect(
      parseEnvelope(JSON.stringify({ ...VAULT_SET, title: carrier })),
    ).toBeNull();
    expect(
      parseEnvelope(JSON.stringify({ ...VAULT_SET, body: carrier })),
    ).toBeNull();
    // And prose that merely quotes the format still sends, as everywhere else.
    const chatty = 'the format is {"tcm":"image"} apparently';
    expect(
      parseEnvelope(JSON.stringify({ ...VAULT_SET, body: chatty })),
    ).toEqual({ ...VAULT_SET, body: chatty });
  });

  it('a del carries no title and no value, so deleting cannot re-transmit', () => {
    expect(encodeEnvelope(VAULT_DEL)).not.toContain(SECRET);
    expect(Object.keys(VAULT_DEL)).toEqual(['tcm', 'op', 'id', 'n', 'k']);
  });
});

/**
 * THE SEND-SIDE SEAM (DIVERGENCE 1). `encodeEnvelope` was a bare
 * `JSON.stringify` with a typed parameter, so every constraint in every schema
 * in envelope.ts was RECEIVER-ONLY — TypeScript checks the shape, and nothing
 * checked `.max(2048)` or the sentinel refusals.
 *
 * The sequence that made it fatal rather than untidy: Alice pastes a 2100-char
 * value. It encodes, encrypts and sends. Bob's `parseEnvelope` returns null, so
 * the vault branch is skipped and the frame falls through to the generic path
 * as "Unsupported message". Bob's client has ALREADY ACKED, which purges the
 * server's copy, and the ratchet key is consumed, so redelivery cannot help —
 * and `reconcileLocalState` also routes through `parseEnvelope`, so not even
 * Alice can replay it. The item is gone on both phones, permanently. The tell
 * was that ALICE'S OWN ROW read "Unsupported message" too, because `previewFor`
 * could not parse what her phone had just composed.
 *
 * These tests are at the envelope layer on purpose: the two existing vault
 * suites mock db wholesale or model the SQL by hand, so NEITHER of them ever
 * crosses this boundary.
 */
describe('encodeEnvelope refuses what parseEnvelope would refuse', () => {
  const ITEM = '01WFXZ3NDEKTSV4RRFFQ69G5AB';

  /** THE PROPERTY, stated once: anything this build can compose, this build can
   * read back. Everything below is an instance of it. */
  function roundTrips(envelope: Parameters<typeof encodeEnvelope>[0]): boolean {
    const encoded = encodeEnvelope(envelope);
    return JSON.stringify(parseEnvelope(encoded)) === JSON.stringify(envelope);
  }

  it('round-trips every envelope this app composes', () => {
    for (const envelope of [
      IMAGE,
      REACT,
      PROFILE,
      TIMER,
      TIMER_OFF,
      SHOT,
      EDIT,
      DEL,
      REPLY,
      { tcm: 'vault', op: 'set', id: ITEM, title: 'Door', body: '4417', n: 1, k: 0 },
      { tcm: 'vault', op: 'del', id: ITEM, n: 2, k: 1 },
    ] as Parameters<typeof encodeEnvelope>[0][]) {
      expect(roundTrips(envelope)).toBe(true);
    }
  });

  it('THE DEFECT: an over-long vault value is refused at COMPOSE, not at the peer', () => {
    // The exact frame that used to vanish. It must now throw here — before
    // encryption, before the ratchet advances, before an outbox row exists,
    // before an ack destroys the only other copy.
    const oversize = {
      tcm: 'vault',
      op: 'set',
      id: ITEM,
      title: 'Backup codes',
      body: 'x'.repeat(VAULT_BODY_MAX + 1),
      n: 1,
      k: 0,
    } as Parameters<typeof encodeEnvelope>[0];
    expect(() => encodeEnvelope(oversize)).toThrow(EnvelopeRefusedError);
    // NON-VACUITY, in the same test: this is precisely the frame that a bare
    // JSON.stringify produced happily and that the receiver then discarded.
    expect(parseEnvelope(JSON.stringify(oversize))).toBeNull();
  });

  it('names the field and never the value — an error string gets logged and copied', () => {
    const secret = 'HUNTER2-DOORCODE-4417'.repeat(600);
    try {
      encodeEnvelope({
        tcm: 'vault',
        op: 'set',
        id: ITEM,
        title: 'Door',
        body: secret,
        n: 1,
        k: 0,
      } as Parameters<typeof encodeEnvelope>[0]);
      throw new Error('should have refused');
    } catch (err) {
      expect((err as EnvelopeRefusedError).name).toBe('EnvelopeRefusedError');
      expect((err as EnvelopeRefusedError).tcm).toBe('vault');
      expect((err as EnvelopeRefusedError).fields).toEqual(['body']);
      expect((err as Error).message).toContain('body');
      expect((err as Error).message).not.toContain('HUNTER2');
    }
  });

  it('protects EVERY envelope kind, not just the vault', () => {
    // One case per constraint class, because the seam is shared: a cap
    // (profile), a sentinel refusal (edit/reply), and a shape (image).
    const refused: Parameters<typeof encodeEnvelope>[0][] = [
      { ...PROFILE, n: 'x'.repeat(41) },
      { ...PROFILE, a: 'x'.repeat(141) },
      { ...REACT, emoji: 'x'.repeat(17) },
      { ...EDIT, text: '{"tcm":"react","ref":"x","ofs":true,"emoji":"!"}' },
      { ...EDIT, text: '' },
      { ...REPLY, text: '{"tcm":"shot"}' },
      { ...TIMER, s: -1 },
      { ...IMAGE, w: 0 },
    ] as Parameters<typeof encodeEnvelope>[0][];
    for (const envelope of refused) {
      expect(() => encodeEnvelope(envelope)).toThrow(EnvelopeRefusedError);
      // Each one would have been discarded silently by the receiver.
      expect(parseEnvelope(JSON.stringify(envelope))).toBeNull();
    }
  });

  it('strips a stray property instead of letting it ride the wire unchecked', () => {
    // What is stringified is the PARSED object, so the bytes on the wire are
    // exactly what the receiver will reconstruct.
    const encoded = encodeEnvelope({
      ...SHOT,
      extra: 'nope',
    } as unknown as Parameters<typeof encodeEnvelope>[0]);
    expect(encoded).toBe(JSON.stringify(SHOT));
  });

  it('still starts with the sentinel, so routing and the thread filter survive', () => {
    // Everything in this app decides what a body IS by its first characters.
    for (const envelope of [IMAGE, PROFILE, TIMER, SHOT, EDIT, REPLY]) {
      expect(encodeEnvelope(envelope).startsWith('{"tcm":')).toBe(true);
    }
  });
});
