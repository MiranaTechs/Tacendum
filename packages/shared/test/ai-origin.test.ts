/**
 * The Art. 50 AI-origin marker. Four
 * rules this file exists to hold down:
 *
 * 1. **The marker costs itself, never the message.** `ai` is receive-side
 *    `.catch(undefined)`: a malformed marker (false, a string, a number)
 *    collapses to "unmarked" and the words still land — §5.5's rule that the
 *    receiver is strictly more permissive than the sender, because a parser
 *    refusal on a one-way ratchet is a permanent loss. Only `true` marks.
 *
 * 2. **Unknown keys strip; they never refuse.** This is the deployed-build
 *    compatibility fact the marker stands on: every shipped parser is a plain
 *    zod object (strip mode), so a NEW optional field on a KNOWN kind is
 *    invisible to old builds rather than fatal. Pinned here so a future
 *    `.strict()` cannot silently turn the marker into a message-killer for
 *    every build already in the field.
 *
 * 3. **`msg` is the marked bare-text carrier.** An agent's plain reply has no
 *    envelope to carry a field, so it gains one — and because `msg` is a NEW
 *    conversational kind that pre-marker builds render as "Unsupported
 *    message", its EMISSION is attestation-gated in the CLI (the
 *    `--stream` posture). The schema itself stays receive-permissive.
 *
 * 4. **Composed bytes start with the sentinel, `tcm` first.** parseEnvelope
 *    routes on the literal prefix `{"tcm":` before parsing anything.
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_TEXT_TCM,
  AgentTextEnvelope,
  MAX_AGENT_TEXT,
  aiOrigin,
  claimsAiOrigin,
  composeAgentText,
} from '../src/ai-origin.js';
import { GroupMessageEnvelope, MAX_GROUP_BODY } from '../src/group-envelope.js';
import { StreamEditEnvelope, composeStreamEdit } from '../src/stream-envelope.js';
import { ApprovalRequestEnvelope } from '../src/approval-envelope.js';
import * as barrel from '../src/index.js';

const ULID = '01J8MEAPPR0VAQ4X2C6TKN9RFV';

const msg = (over: Record<string, unknown> = {}) => ({
  tcm: 'msg',
  text: 'Done — the tests are green.',
  ai: true,
  ...over,
});

const grpMsg = (over: Record<string, unknown> = {}) => ({
  tcm: 'grp.msg',
  g: ULID,
  m: ULID,
  rd: 'AAAAAAAAAAA',
  sq: 1,
  b: 'plain words',
  ...over,
});

const streamEdit = (over: Record<string, unknown> = {}) => ({
  tcm: 'x.edit',
  ref: ULID,
  seq: 3,
  text: 'The answer so far.',
  ...over,
});

const approval = (over: Record<string, unknown> = {}) => ({
  tcm: 'x.approval',
  q: ULID,
  k: 'exec',
  p: 'ls -la\ncwd: /tmp',
  x: 120,
  a: ['approve', 'deny'],
  ...over,
});

describe('the marker fragment', () => {
  it('keeps exactly `true` and nothing else', () => {
    expect(aiOrigin.parse(true)).toBe(true);
    expect(aiOrigin.parse(undefined)).toBeUndefined();
  });

  it('collapses every malformed value to unmarked — the marker costs itself, never the message', () => {
    expect(aiOrigin.parse(false)).toBeUndefined();
    expect(aiOrigin.parse('yes')).toBeUndefined();
    expect(aiOrigin.parse(1)).toBeUndefined();
    expect(aiOrigin.parse(null)).toBeUndefined();
  });
});

describe('the msg envelope (marked bare text)', () => {
  it('parses the canonical marked shape', () => {
    const parsed = AgentTextEnvelope.parse(msg());
    expect(parsed.tcm).toBe('msg');
    expect(parsed.text).toBe('Done — the tests are green.');
    expect(parsed.ai).toBe(true);
    expect(claimsAiOrigin(parsed)).toBe(true);
  });

  it('parses unmarked text too — the kind is general, the marker is a field', () => {
    const parsed = AgentTextEnvelope.parse(msg({ ai: undefined }));
    expect(parsed.ai).toBeUndefined();
    expect(claimsAiOrigin(parsed)).toBe(false);
  });

  it('a malformed marker costs the marker, never the words', () => {
    const parsed = AgentTextEnvelope.parse(msg({ ai: 'true' }));
    expect(parsed.text).toBe('Done — the tests are green.');
    expect(claimsAiOrigin(parsed)).toBe(false);
  });

  it('refuses an empty text and a leading envelope sentinel', () => {
    expect(AgentTextEnvelope.safeParse(msg({ text: '' })).success).toBe(false);
    expect(
      AgentTextEnvelope.safeParse(msg({ text: '{"tcm":"del","ref":"x"}' })).success,
    ).toBe(false);
  });

  it('bounds text at MAX_AGENT_TEXT, which mirrors MAX_GROUP_BODY — pinned so drift is visible', () => {
    expect(MAX_AGENT_TEXT).toBe(MAX_GROUP_BODY);
    expect(
      AgentTextEnvelope.safeParse(msg({ text: 'a'.repeat(MAX_AGENT_TEXT + 1) })).success,
    ).toBe(false);
    expect(
      AgentTextEnvelope.safeParse(msg({ text: 'a'.repeat(MAX_AGENT_TEXT) })).success,
    ).toBe(true);
  });

  it('strips unknown keys instead of refusing — the deployed-parser tolerance ungated emission stands on', () => {
    const parsed = AgentTextEnvelope.parse(msg({ zz: 'stowaway' }));
    expect(parsed).not.toHaveProperty('zz');
  });

  it('AGENT_TEXT_TCM names the kind once', () => {
    expect(AGENT_TEXT_TCM).toBe('msg');
  });
});

describe('composeAgentText', () => {
  it('serializes tcm first and carries the marker — every composed msg is marked', () => {
    const bytes = composeAgentText('Done.');
    expect(bytes.startsWith('{"tcm":"msg"')).toBe(true);
    expect(bytes).toContain('"ai":true');
    const parsed = AgentTextEnvelope.parse(JSON.parse(bytes));
    expect(parsed.text).toBe('Done.');
    expect(parsed.ai).toBe(true);
  });

  it('refuses to compose what it could not parse — empty, sentinel-leading, overgrown', () => {
    expect(() => composeAgentText('')).toThrow();
    expect(() => composeAgentText('{"tcm":"del","ref":"x"}')).toThrow();
    expect(() => composeAgentText('a'.repeat(MAX_AGENT_TEXT + 1))).toThrow();
  });

  it('quoting the sentinel mid-sentence still composes', () => {
    const bytes = composeAgentText('bodies that start with {"tcm": are refused');
    expect(AgentTextEnvelope.parse(JSON.parse(bytes)).ai).toBe(true);
  });
});

describe('the marker on the carrier envelopes the CLI composes', () => {
  it('grp.msg retains ai:true — the room lane rides the wrapper, invisible to pre-marker builds', () => {
    const parsed = GroupMessageEnvelope.parse(grpMsg({ ai: true }));
    expect(parsed.ai).toBe(true);
    expect(claimsAiOrigin(parsed)).toBe(true);
  });

  it('grp.msg without the marker parses exactly as before', () => {
    const parsed = GroupMessageEnvelope.parse(grpMsg());
    expect(parsed.ai).toBeUndefined();
    expect(claimsAiOrigin(parsed)).toBe(false);
  });

  it('grp.msg with a malformed marker keeps the message', () => {
    const parsed = GroupMessageEnvelope.parse(grpMsg({ ai: 'x' }));
    expect(parsed.b).toBe('plain words');
    expect(claimsAiOrigin(parsed)).toBe(false);
  });

  it('x.edit retains ai:true, and composeStreamEdit carries it on the bytes', () => {
    expect(StreamEditEnvelope.parse(streamEdit({ ai: true })).ai).toBe(true);
    const marked = composeStreamEdit({ ref: ULID, seq: 4, text: 'snap', ai: true });
    expect(marked.startsWith('{"tcm":"x.edit"')).toBe(true);
    expect(marked).toContain('"ai":true');
    expect(StreamEditEnvelope.parse(JSON.parse(marked)).ai).toBe(true);
  });

  it('composeStreamEdit without ai stays byte-free of the field — pre-marker callers unchanged', () => {
    const plain = composeStreamEdit({ ref: ULID, seq: 4, text: 'snap' });
    expect(plain).not.toContain('"ai"');
  });

  it('x.approval retains ai:true and collapses a malformed one', () => {
    expect(ApprovalRequestEnvelope.parse(approval({ ai: true })).ai).toBe(true);
    const parsed = ApprovalRequestEnvelope.parse(approval({ ai: 0 }));
    expect(parsed.p).toBe('ls -la\ncwd: /tmp');
    expect(claimsAiOrigin(parsed)).toBe(false);
  });
});

describe('the deployed-parser tolerance, pinned per schema', () => {
  // The compatibility fact ungated emission stands on: every
  // envelope schema is a plain zod object in strip mode, so a KNOWN kind
  // carrying an UNKNOWN field parses fine on every shipped build. A future
  // `.strict()` on any of these would turn the marker into a message-killer
  // for builds already in the field — this pin is what makes that loud.
  it('grp.msg, x.edit and x.approval all strip an unknown key rather than refuse', () => {
    expect(GroupMessageEnvelope.safeParse(grpMsg({ zz: 1 })).success).toBe(true);
    expect(StreamEditEnvelope.safeParse(streamEdit({ zz: 1 })).success).toBe(true);
    expect(ApprovalRequestEnvelope.safeParse(approval({ zz: 1 })).success).toBe(true);
  });
});

describe('the barrel', () => {
  it('exports the marker pieces — a shared module unreachable from the app is drift waiting', () => {
    expect(barrel.AgentTextEnvelope).toBeDefined();
    expect(barrel.composeAgentText).toBeDefined();
    expect(barrel.claimsAiOrigin).toBeDefined();
    expect(barrel.MAX_AGENT_TEXT).toBeDefined();
  });
});
