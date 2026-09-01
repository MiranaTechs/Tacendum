import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tacendum-blocked-'));
process.env.TACENDUM_HOME = home;

const { loadBlocked, isBlocked, blockedPath, resetBlockedWarnings } =
  await import('../src/blocked.js');

const ANA = '01CCCCCCCCCCCCCCCCCCCCCCCC';
const EVE = '01EEEEEEEEEEEEEEEEEEEEEEEE';

function writeBlocked(name: string, body: string): void {
  mkdirSync(join(home, 'state', name), { recursive: true });
  writeFileSync(blockedPath(name), body);
}

afterEach(() => {
  resetBlockedWarnings();
  vi.restoreAllMocks();
});

/**
 * The CLI's block list.
 *
 * The property under test is not "blocking works" — it is that ABSENT and
 * CORRUPT are told apart. Both end at the same place (nobody blocked, because
 * a block list that silences everyone on one bad byte is worse than one that
 * silences nobody), and only one of them is worth a word. A blocked person's
 * messages reappearing with no explanation is indistinguishable from the
 * block never having been set, which is the failure this suite exists for.
 */
describe('the CLI block list', () => {
  it('no file means nobody is blocked, silently — that is the ordinary state', () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(loadBlocked('quiet').size).toBe(0);
    expect(isBlocked('quiet', EVE)).toBe(false);
    expect(err).not.toHaveBeenCalled();
  });

  it('reads the ids it is given', () => {
    writeBlocked('reader', JSON.stringify([EVE]));
    expect(isBlocked('reader', EVE)).toBe(true);
    expect(isBlocked('reader', ANA)).toBe(false);
  });

  it('is read per frame, so an operator editing it mid-session needs no restart', () => {
    writeBlocked('live', JSON.stringify([]));
    expect(isBlocked('live', EVE)).toBe(false);
    writeBlocked('live', JSON.stringify([EVE]));
    expect(isBlocked('live', EVE)).toBe(true);
  });

  it('a CORRUPT file fails open but SAYS SO — loudly, on stderr, naming the path', () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    writeBlocked('broken', 'not json{{{');

    expect(loadBlocked('broken').size).toBe(0);
    expect(err).toHaveBeenCalledTimes(1);
    const said = String(err.mock.calls[0]?.[0]);
    // The operator has to be able to FIX it, so the message names the file
    // and states the consequence in the words that matter.
    expect(said).toContain(blockedPath('broken'));
    expect(said).toContain('NOBODY is blocked');
    // stderr, never stdout: a `listen` piped into a tool must not gain a line
    // that could be mistaken for a message.
  });

  it('a file that parses but is not a list of ids is corrupt, not empty', () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    writeBlocked('shaped', JSON.stringify({ blocked: [EVE] }));
    expect(loadBlocked('shaped').size).toBe(0);
    // The tempting reading of `{"blocked":[...]}` is "an empty list", and that
    // would silently ignore a plausible hand-written file. It is a shape this
    // build does not honour, so it warns like any other unreadable one.
    expect(err).toHaveBeenCalledTimes(1);
  });

  it('warns ONCE per account, not once per inbound frame', () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    writeBlocked('noisy', '}{');
    for (let i = 0; i < 50; i++) isBlocked('noisy', EVE);
    // `listen` is long-running and consults this on every frame. The operator
    // should learn once; 50 identical lines is how a real warning gets
    // filtered out by the person reading it.
    expect(err).toHaveBeenCalledTimes(1);
  });

  it('non-string entries are dropped without discarding the valid ones', () => {
    writeBlocked('mixed', JSON.stringify([EVE, 42, null, ANA]));
    expect(isBlocked('mixed', EVE)).toBe(true);
    expect(isBlocked('mixed', ANA)).toBe(true);
    expect(loadBlocked('mixed').size).toBe(2);
  });
});
