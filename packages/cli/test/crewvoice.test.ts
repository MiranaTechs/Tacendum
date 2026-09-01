import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hermetic before ANY src import (run.test.ts's rule): crewvoice pulls
// config.ts for the lock's home, and nothing here may resolve a real host.
const home = mkdtempSync(join(tmpdir(), 'tacendum-voice-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://voice.test';
process.env.TACENDUM_WS = 'ws://voice.test';

const {
  CREW_VOICE_BODY,
  crewVoiceBlock,
  crewVoiceSkillMd,
  mergeVoiceMarkdown,
  preflightCrewVoice,
  voiceTargetFor,
  writeCrewVoice,
} = await import('../src/crewvoice.js');
const { HOOK_CHAT_CAP, capChatHead, composeHookBody, plainForChat } = await import(
  '../src/hooks.js'
);
const { CliError } = await import('../src/exit.js');

// ---------------------------------------------------------------------------
// The chat cap (spec Task A #3). The budget is enforced HERE, once, so an
// agent that never reads the skill still fits the room.
// ---------------------------------------------------------------------------

describe('capChatHead', () => {
  it('leaves a within-budget body untouched, byte for byte', () => {
    const short = 'Done: flake closed. 668 green.';
    expect(capChatHead(short)).toBe(short);
    expect(capChatHead('')).toBe('');
    expect(capChatHead('x'.repeat(HOOK_CHAT_CAP))).toBe('x'.repeat(HOOK_CHAT_CAP));
  });

  it('keeps the HEAD and cuts at the last sentence boundary that fits', () => {
    const outcome = 'Fixed the flake. The reader raced the writer over an empty pid file.';
    const report = `${outcome} ${'Here is everything about how I did it. '.repeat(30)}`;
    const capped = capChatHead(report);
    expect(capped.length).toBeLessThanOrEqual(HOOK_CHAT_CAP);
    // Head, not tail: the outcome sentence survives, the trailing prose dies.
    expect(capped.startsWith('Fixed the flake.')).toBe(true);
    expect(capped.endsWith('…')).toBe(true);
    // The cut is a sentence seam, so what remains before the ellipsis is a
    // complete sentence, not a word fragment.
    expect(capped).toMatch(/[.!?] …$/);
  });

  it('treats a newline as a boundary, so a report-shaped body clips at its first paragraph', () => {
    const body = `Outcome: shipped\n${'detail '.repeat(100)}`;
    const capped = capChatHead(body);
    expect(capped).toBe('Outcome: shipped …');
  });

  it('hard-cuts a boundary-free body without splitting a surrogate pair', () => {
    // Astral characters are two UTF-16 units; a naive slice can land between
    // them and ship half a codepoint into an encrypted message body.
    const emoji = '🌲'.repeat(HOOK_CHAT_CAP); // length 2 each, no boundaries
    const capped = capChatHead(emoji);
    expect(capped.length).toBeLessThanOrEqual(HOOK_CHAT_CAP);
    expect(capped.endsWith('…')).toBe(true);
    // Round-trip through UTF-8: a split pair would surface as U+FFFD.
    expect(Buffer.from(capped, 'utf8').toString('utf8')).toBe(capped);
    expect(capped.includes('�')).toBe(false);
  });

  it('is idempotent: a capped body passes through unchanged', () => {
    const once = capChatHead('word '.repeat(200));
    expect(capChatHead(once)).toBe(once);
  });

  it('applies inside the one funnel every host body crosses', () => {
    const body = `The answer. ${'x'.repeat(5000)}`;
    const composed = composeHookBody({ kind: 'finished', body, projectTag: 'repo' }, undefined);
    const [title, ...rest] = composed.split('\n');
    expect(title).toBe('repo: agent finished');
    expect(rest.join('\n').length).toBeLessThanOrEqual(HOOK_CHAT_CAP);
    expect(rest.join('\n')).toBe('The answer. …');
  });
});

// ---------------------------------------------------------------------------
// The voice text and its per-host landing (spec Task A #1–2).
// ---------------------------------------------------------------------------

describe('the canonical voice', () => {
  it('is one text: the skill file and the fenced block both carry it verbatim', () => {
    expect(crewVoiceSkillMd()).toContain(CREW_VOICE_BODY);
    expect(crewVoiceBlock()).toContain(CREW_VOICE_BODY);
  });

  it('teaches the budget it is enforced under, so the two never drift silently', () => {
    // The skill quotes the cap as prose; if HOOK_CHAT_CAP changes without the
    // text, agents are taught a stale number.
    expect(CREW_VOICE_BODY).toContain(String(HOOK_CHAT_CAP));
  });

  it('claude gets an owned skill file; codex/gemini get merged blocks; cursor gets nothing to write', () => {
    expect(voiceTargetFor('claude-code')).toMatchObject({ kind: 'own' });
    expect(voiceTargetFor('claude-code').path).toContain(join('.claude', 'skills', 'crew-chat'));
    expect(voiceTargetFor('codex')).toMatchObject({ kind: 'merge' });
    expect(voiceTargetFor('gemini')).toMatchObject({ kind: 'merge' });
    expect(voiceTargetFor('cursor')).toEqual({ path: null, kind: 'none' });
  });
});

describe('mergeVoiceMarkdown', () => {
  const path = '/x/AGENTS.md';

  it('appends to a file with no markers, leaving the operator content byte-identical', () => {
    const theirs = '# My agents\n\nDo not touch my stuff.\n';
    const merged = mergeVoiceMarkdown(theirs, path);
    expect(merged.startsWith('# My agents\n\nDo not touch my stuff.\n')).toBe(true);
    expect(merged).toContain(CREW_VOICE_BODY);
  });

  it('replaces ONLY between the markers on re-run; edits outside survive', () => {
    const first = mergeVoiceMarkdown('# Mine\n', path);
    const editedOutside = `${first}\n## Their new section\nkeep me\n`;
    const again = mergeVoiceMarkdown(editedOutside, path);
    expect(again).toContain('## Their new section\nkeep me');
    expect(again).toContain('# Mine');
    // Exactly one block — a re-run must not stack a second copy.
    expect(again.split('tacendum:crew-voice:begin').length - 1).toBe(1);
  });

  it('is idempotent when nothing changed', () => {
    const once = mergeVoiceMarkdown('# Mine\n', path);
    expect(mergeVoiceMarkdown(once, path)).toBe(once);
  });

  it('never deletes text it cannot recognize as its own: a marker pair around OPERATOR text refuses', () => {
    // The gate's repro: markers planted around the operator's own prose (a
    // code-fence example, a copy-paste accident). The old merge replaced
    // between them and the prose vanished. Recognition is the block heading;
    // without it, refusal.
    const trap = `# Mine\n\n${'<!-- tacendum:crew-voice:begin -->'}\nthe operator's own words\n${'<!-- tacendum:crew-voice:end -->'}\n`;
    expect(() => mergeVoiceMarkdown(trap, path)).toThrowError(/did not write/);
  });

  it('refuses a marker quoted inline in the operator prose instead of adopting it', () => {
    const prose = `Docs: the \`<!-- tacendum:crew-voice:begin -->\` marker starts the block.\n<!-- tacendum:crew-voice:end -->\n`;
    expect(() => mergeVoiceMarkdown(prose, path)).toThrowError(/inside a line/);
  });

  it('refuses ambiguous markers rather than guessing (duplicate, lone, reversed)', () => {
    const block = crewVoiceBlock();
    const dup = `${block}\n${block}\n`;
    expect(() => mergeVoiceMarkdown(dup, path)).toThrowError(CliError);
    expect(() => mergeVoiceMarkdown('<!-- tacendum:crew-voice:begin -->\nonly\n', path)).toThrowError(
      /refusing to guess/,
    );
    const reversed = '<!-- tacendum:crew-voice:end -->\nx\n<!-- tacendum:crew-voice:begin -->\n';
    expect(() => mergeVoiceMarkdown(reversed, path)).toThrowError(CliError);
  });
});

describe('writeCrewVoice', () => {
  it('creates the claude skill file whole, and a rerun writes nothing', () => {
    const target = join(mkdtempSync(join(tmpdir(), 'voice-own-')), 'SKILL.md');
    const first = writeCrewVoice('claude-code', { targetPath: target });
    expect(first).toMatchObject({ path: target, changed: true, backup: null });
    expect(readFileSync(target, 'utf8')).toBe(crewVoiceSkillMd());
    const again = writeCrewVoice('claude-code', { targetPath: target });
    expect(again).toMatchObject({ changed: false, backup: null });
  });

  it('merges into an existing AGENTS.md with a backup, preserving the operator content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-merge-'));
    const target = join(dir, 'AGENTS.md');
    writeFileSync(target, '# Operator rules\nmine\n');
    const out = writeCrewVoice('codex', {
      targetPath: target,
      now: () => new Date('2026-07-31T00:00:00Z'),
    });
    expect(out.changed).toBe(true);
    expect(out.backup).not.toBeNull();
    expect(readFileSync(out.backup as string, 'utf8')).toBe('# Operator rules\nmine\n');
    const merged = readFileSync(target, 'utf8');
    expect(merged).toContain('# Operator rules\nmine');
    expect(merged).toContain(CREW_VOICE_BODY);
    // Rerun: no change, no backup litter.
    const again = writeCrewVoice('codex', { targetPath: target });
    expect(again).toMatchObject({ changed: false, backup: null });
    expect(readdirSync(dir).filter((n) => n.includes('.bak.'))).toHaveLength(1);
  });

  it('cursor: reports null path and touches no filesystem', () => {
    expect(writeCrewVoice('cursor')).toEqual({ path: null, changed: false, backup: null });
  });

  it('REFUSES a hand-made skill under our name instead of clobbering it', () => {
    // An earlier review: a pre-existing crew-chat/SKILL.md the operator wrote
    // themselves was overwritten with no refusal and no backup. Ownership is
    // the installed marker line; a file without it is not ours to replace.
    const target = join(mkdtempSync(join(tmpdir(), 'voice-hand-')), 'SKILL.md');
    writeFileSync(target, '---\nname: crew-chat\n---\n\nMy own carefully tuned voice.\n');
    expect(() => writeCrewVoice('claude-code', { targetPath: target })).toThrowError(
      /not written by tacendum setup/,
    );
    expect(readFileSync(target, 'utf8')).toContain('My own carefully tuned voice.');
    // And OUR file (it carries the ownership line) still updates freely.
    const ours = join(mkdtempSync(join(tmpdir(), 'voice-ours-')), 'SKILL.md');
    writeCrewVoice('claude-code', { targetPath: ours });
    expect(writeCrewVoice('claude-code', { targetPath: ours }).changed).toBe(false);
  });
});

describe('preflightCrewVoice', () => {
  it('surfaces the refusal a write would make, before any write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-pre-'));
    const bad = join(dir, 'AGENTS.md');
    writeFileSync(bad, '<!-- tacendum:crew-voice:begin -->\nlone marker\n');
    expect(() => preflightCrewVoice('codex', { targetPath: bad })).toThrowError(CliError);
    // The preflight only reads.
    expect(readFileSync(bad, 'utf8')).toContain('lone marker');
    const fine = join(dir, 'CLEAN.md');
    writeFileSync(fine, '# theirs\n');
    expect(() => preflightCrewVoice('codex', { targetPath: fine })).not.toThrow();
    expect(readFileSync(fine, 'utf8')).toBe('# theirs\n');
  });
});

describe('plainForChat — markdown degraded to chat prose', () => {
  it('strips the exact noise the first real notification carried', () => {
    // The operator's phone showed this verbatim, asterisks and all.
    const md = '**Delivered — check your phone.** The "Claude · laptop" chat should now show: *"Got both your tests."*';
    expect(plainForChat(md)).toBe(
      'Delivered — check your phone. The "Claude · laptop" chat should now show: "Got both your tests."',
    );
  });

  it('keeps content, drops decoration: code, links, headings, quotes, bullets', () => {
    const md = [
      '## What happened',
      '> a quote',
      'Run `tacendum sync` then see [the docs](https://example.com/x).',
      '- first thing',
      '* second thing',
      '```bash',
      'make build',
      '```',
    ].join('\n');
    const plain = plainForChat(md);
    expect(plain).toContain('What happened');
    expect(plain).toContain('a quote');
    expect(plain).toContain('Run tacendum sync then see the docs.');
    expect(plain).toContain('· first thing');
    expect(plain).toContain('· second thing');
    expect(plain).toContain('make build');
    expect(plain).not.toMatch(/[#>`]|\]\(|```/);
    expect(plain).not.toContain('https://example.com');
  });

  it('leaves non-markdown text alone: snake_case, arithmetic, lone asterisks', () => {
    const honest = 'set retry_count to 2 * 3 in config_file.ts, or a*b if you must';
    expect(plainForChat(honest)).toBe(honest);
  });

  it('is idempotent, and runs BEFORE the cap so syntax never bills the budget', () => {
    const md = `**${'word '.repeat(100).trim()}**`;
    expect(plainForChat(plainForChat(md))).toBe(plainForChat(md));
    const composed = composeHookBody({ kind: 'finished', body: md }, undefined);
    const body = composed.split('\n').slice(1).join('\n');
    expect(body.startsWith('word word')).toBe(true);
    expect(body).not.toContain('**');
    expect(body.length).toBeLessThanOrEqual(HOOK_CHAT_CAP);
  });
});

describe('an earlier review cap edges', () => {
  it('an exactly-fitting sentence boundary is used, not fallen past', () => {
    // 277 a's + '. ' + tail: the boundary's following space is the 279th
    // char, which the old window (cut at 278) could not see — the body
    // shipped as a hard cut ending ".…".
    const text = `${'a'.repeat(277)}. ${'tail '.repeat(20)}`;
    const capped = capChatHead(text);
    expect(capped.length).toBeLessThanOrEqual(HOOK_CHAT_CAP);
    expect(capped.endsWith('. …')).toBe(true);
  });

  it('recognizes fullwidth and Arabic sentence enders', () => {
    const jp = `結論です。 ${'詳細'.repeat(300)}`;
    expect(capChatHead(jp)).toBe('結論です。 …');
    const ar = `تم الإصلاح؟ ${'تفاصيل '.repeat(200)}`;
    expect(capChatHead(ar)).toBe('تم الإصلاح؟ …');
  });

  it('an over-cap all-whitespace body caps to nothing, not to a bare ellipsis', () => {
    expect(capChatHead('\n'.repeat(281))).toBe('');
    // And the funnel then omits the body line entirely.
    const composed = composeHookBody({ kind: 'finished', body: '\n'.repeat(281) }, undefined);
    expect(composed).toBe('agent finished');
  });

  it('a hard cut lands on a grapheme boundary — ZWJ families survive whole', () => {
    const family = '👨‍👩‍👧‍👦'; // 11 UTF-16 units of ZWJ-joined cluster
    const capped = capChatHead(family.repeat(60));
    expect(capped.endsWith('…')).toBe(true);
    expect(capped.length).toBeLessThanOrEqual(HOOK_CHAT_CAP);
    // Every kept cluster is intact: stripping the ellipsis leaves a string
    // that is a whole number of families.
    const kept = capped.slice(0, -1);
    expect(kept.length % family.length).toBe(0);
    expect(kept).toBe(family.repeat(kept.length / family.length));
  });
});
