import {
  BLOCK_COPY,
  BLOCK_EXPLAINER,
  FETCH_WHILE_BLOCKED,
  OUTBOUND_WHILE_BLOCKED,
  blockStatusTone,
  isBlocked,
  mayApplyPeerMutation,
  mayDecryptInbound,
  mayFetchFor,
  mayPersistInbound,
  maySendTo,
  mustAckInbound,
} from '../src/blocking';
import type {
  BlockState,
  BlockTone,
  InboundFetchKind,
  OutboundKind,
} from '../src/blocking';

/**
 * The block decision table is the feature. Its only real property — that a
 * blocked person cannot tell they have been blocked — is held by every path
 * agreeing, so every assertion here is a NEGATIVE: that nothing goes out, and
 * that nothing is fetched. A test that merely proved a boolean was set would
 * prove nothing at all. Pure module, no mocks.
 */

const BLOCKED: BlockState = { blockedAt: 1_753_000_000_000 };
const CLEAR: BlockState = { blockedAt: null };

/**
 * Written out by hand rather than derived from the table, so that adding an
 * OutboundKind without testing it fails the length assertion below. Deriving
 * the list from the thing under test would make the sweep vacuous.
 */
const ALL_KINDS: OutboundKind[] = [
  'message',
  'reaction',
  'edit',
  'retraction',
  'screenshotNotice',
  'profileCard',
  'vaultItem',
  // Room traffic argues its own rows: a fan-out leg and
  // a membership write must never inherit the 1:1 'message' decision.
  'groupMessage',
  'groupRoster',
  'readReceipt',
  'callSignal',
  'queuedEnvelope',
  'deliveryReceipt',
  'typingState',
];

const ALL_FETCHES: InboundFetchKind[] = ['attachment', 'avatar'];

const TONES: BlockTone[] = [
  'warningMark',
  'warningInk',
  'paperLayer',
  'lineStrong',
  'inkMuted',
  'inkStrong',
  'inkBody',
];

describe('isBlocked', () => {
  it('reads the timestamp, not its truthiness', () => {
    expect(isBlocked(CLEAR)).toBe(false);
    expect(isBlocked(BLOCKED)).toBe(true);
    // A block recorded at epoch 0 is still a block. `!state.blockedAt` would
    // silently unblock it, which is the exact class of bug this feature dies
    // on.
    expect(isBlocked({ blockedAt: 0 })).toBe(true);
  });
});

describe('nothing goes back while blocked', () => {
  it('refuses every outbound kind there is', () => {
    // The sweep only means anything if the list is complete: a new kind added
    // to OUTBOUND_WHILE_BLOCKED and not added here is a beacon nobody tested.
    expect(ALL_KINDS).toHaveLength(Object.keys(OUTBOUND_WHILE_BLOCKED).length);
    expect(new Set(ALL_KINDS).size).toBe(ALL_KINDS.length);
    for (const kind of ALL_KINDS) {
      expect(maySendTo(kind, BLOCKED)).toBe(false);
    }
  });

  it('holds the table at false even for a caller that skips the type', () => {
    // Record<OutboundKind, false> forbids a `true` at compile time; this is
    // the same guarantee for JavaScript callers and for a bad merge.
    for (const value of Object.values(OUTBOUND_WHILE_BLOCKED)) {
      expect(value).toBe(false);
    }
  });

  it('permits every outbound kind when nobody is blocked', () => {
    for (const kind of ALL_KINDS) {
      expect(maySendTo(kind, CLEAR)).toBe(true);
    }
  });
});

describe('no network fetch a blocked peer can trigger', () => {
  it('refuses attachment and avatar fetches while blocked', () => {
    // A blob fetch is a read receipt through a side channel: it proves to
    // anyone watching the blob store that the message was received and parsed.
    expect(ALL_FETCHES).toHaveLength(Object.keys(FETCH_WHILE_BLOCKED).length);
    for (const kind of ALL_FETCHES) {
      expect(mayFetchFor(kind, BLOCKED)).toBe(false);
      expect(FETCH_WHILE_BLOCKED[kind]).toBe(false);
    }
  });

  it('permits them when nobody is blocked', () => {
    for (const kind of ALL_FETCHES) {
      expect(mayFetchFor(kind, CLEAR)).toBe(true);
    }
  });
});

describe('inbound: decrypt, then drop', () => {
  it('always decrypts, so the ratchet stays in sync for an unblock', () => {
    expect(mayDecryptInbound(BLOCKED)).toBe(true);
    expect(mayDecryptInbound(CLEAR)).toBe(true);
  });

  it('always acks, so the queue drains identically for everyone', () => {
    // The ack goes to the server and is never routed to the peer. Not acking
    // would be the observable difference.
    expect(mustAckInbound(BLOCKED)).toBe(true);
    expect(mustAckInbound(CLEAR)).toBe(true);
  });

  it('persists nothing from a blocked peer', () => {
    expect(mayPersistInbound(BLOCKED)).toBe(false);
    expect(mayPersistInbound(CLEAR)).toBe(true);
  });

  it('lets a blocked peer rewrite nothing already on the phone', () => {
    // Inbound edit, retraction and reaction all pass through here.
    expect(mayApplyPeerMutation(BLOCKED)).toBe(false);
    expect(mayApplyPeerMutation(CLEAR)).toBe(true);
  });
});

describe('blockStatusTone', () => {
  it('names theme tokens and never a colour', () => {
    for (const state of [BLOCKED, CLEAR]) {
      const tone = blockStatusTone(state);
      expect(TONES).toContain(tone.rule);
      expect(TONES).toContain(tone.ink);
      expect(tone.rule).not.toMatch(/#|rgba/);
      expect(tone.ink).not.toMatch(/#|rgba/);
    }
  });

  it('renders a settled decision as a thing to do, never as an alarm', () => {
    // Red is reserved for the irreversible and the alarming. Someone's own
    // choice shown in red reads as a fault they committed.
    expect(blockStatusTone(BLOCKED)).toEqual({
      rule: 'warningMark',
      ink: 'warningInk',
    });
    expect(blockStatusTone(CLEAR)).toEqual({
      rule: 'lineStrong',
      ink: 'inkMuted',
    });
  });
});

describe('copy deck', () => {
  /** Every sentence this module can put on a screen or into VoiceOver. */
  const lines: { where: string; text: string }[] = [
    ...Object.entries(BLOCK_COPY).map(([key, value]) => ({
      where: `BLOCK_COPY.${key}`,
      text: typeof value === 'function' ? value('Sam', 'see you') : value,
    })),
    ...BLOCK_EXPLAINER.map((text, i) => ({
      where: `BLOCK_EXPLAINER[${i}]`,
      text,
    })),
  ];

  it('never claims the block stops, prevents or shields anything', () => {
    /**
     * The honesty rule. A block does not stop delivery — their messages still
     * arrive and are discarded here — so copy that implies otherwise leaves
     * someone believing they are unreachable by a person who is still sending.
     *
     * Two literal phrases are exempt, and only these two. 'does not stop them
     * sending' is the honest sentence itself. 'you stopped replying' describes
     * how the chat LOOKS from the blocked person's side, which is the
     * property the feature is built to produce, not a claim about what the
     * block does.
     */
    const EXEMPT = ['does not stop them sending', 'you stopped replying'];
    const OVERCLAIM =
      /stop|prevent|shield|can’t reach|cannot reach|won’t receive|will not receive/i;

    for (const { where, text } of lines) {
      const remainder = EXEMPT.reduce(
        (s, phrase) => s.split(phrase).join(''),
        text,
      );
      expect([where, OVERCLAIM.test(remainder)]).toEqual([where, false]);
    }
    // The exemptions must not be load-bearing for a deck that quietly dropped
    // the honest sentence.
    expect(BLOCK_EXPLAINER[1]).toContain('does not stop them sending');
  });

  it('uses typographic apostrophes everywhere', () => {
    for (const { where, text } of lines) {
      expect([where, text.includes("'")]).toEqual([where, false]);
    }
    expect(BLOCK_COPY.failed).toBe('Tacendum couldn’t save that. Try again.');
  });

  it('says what happens to their messages, in both places that say it', () => {
    // The consequence sits above the button in both flows, which is why
    // unblocking needs no second confirmation.
    expect(BLOCK_COPY.confirmBody).toContain('discarded as it arrives');
    expect(BLOCK_COPY.confirmBody).toContain('will not bring it back');
    expect(BLOCK_COPY.blockedBody).toContain('discarded');
    expect(BLOCK_EXPLAINER).toHaveLength(3);
    expect(BLOCK_EXPLAINER[2]).toContain('no calls');
  });

  it('names the person first and the state second for VoiceOver', () => {
    expect(BLOCK_COPY.rowLabel('Sam', 'see you')).toBe('Sam, blocked, see you');
  });

  it('leaves no placeholder behind and no empty sentence', () => {
    for (const { where, text } of lines) {
      expect([where, text.includes('{')]).toEqual([where, false]);
      expect([where, text.includes('undefined')]).toEqual([where, false]);
      expect(text.length).toBeGreaterThan(0);
    }
  });
});
