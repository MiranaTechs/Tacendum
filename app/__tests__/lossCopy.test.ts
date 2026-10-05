/**
 * The loss page deck.
 *
 * The honest inventory of what a lost device costs exists nowhere a person
 * can read it after registration: "Why there is no recovery" lives inside
 * the create ceremony, "There is no backup" inside a delete-account
 * confirmation, and the recovery scope one screen deeper than the door that
 * offers it. Being the messenger that says this plainly BEFORE the bad day
 * is free, and nobody else does it.
 *
 * EVERY LINE NAMES A MODULE IT MUST AGREE WITH, and this suite is where the
 * agreement is checked. A page like this is only worth shipping if each
 * sentence is true of the build that carries it; a comforting sentence here
 * would be read on the worst day of somebody's year.
 *
 * The deck uses the same device-neutral wording as `fieldModeCopy.ts`,
 * keeping its promises applicable across supported devices.
 */
import { ACCOUNTS_COPY } from '../src/accountsCopy';
import { LINKING_COPY } from '../src/linkingCopy';
import { LOSS_COPY } from '../src/lossCopy';
import { SAFETY_COPY, SAFETY_EXPLAINER } from '../src/safety';

describe('the deck, by identity', () => {
  it('is the row label, a title, four lines and one ⓘ — nothing else', () => {
    expect(Object.keys(LOSS_COPY).sort()).toEqual([
      'infoLabel',
      'infoLines',
      'lines',
      'row',
      'title',
    ]);
    expect(LOSS_COPY.row).toBe('If this is lost or taken');
    expect(LOSS_COPY.title).toBe('If this is lost or taken');
    expect(LOSS_COPY.lines).toHaveLength(4);
    expect(LOSS_COPY.infoLines).toEqual([
      'Worth reading once, now, rather than on the day.',
    ]);
  });

  it('line 1 — the key was made here and nobody else ever had it', () => {
    expect(LOSS_COPY.lines[0]).toBe(
      'Your identity is a key that was made here and has never left. If it is gone, it is gone — nobody at Tacendum can bring it back, because we never had it.',
    );
  });

  it('line 2 — what goes with it, and that you would come back as someone new', () => {
    expect(LOSS_COPY.lines[1]).toBe(
      'What goes with it: your Tacendum ID, every room here, and the trust each person has pinned to you. To reach them again you would be someone new, and they would add you again.',
    );
  });

  it('line 3 — what an email brings back, in the scope the recovery deck states', () => {
    expect(LOSS_COPY.lines[2]).toBe(
      'What an email brings back, if you have linked one: which devices are yours, and being findable by that email. Never the key, never the messages, never the trust — everyone sees a fresh safety number.',
    );
  });

  it('line 4 — a second linked device is not a backup', () => {
    expect(LOSS_COPY.lines[3]).toBe(
      'What helps today: a second linked device keeps its own copy of what it has seen since you linked it. It is not a backup — it starts empty and fills from there.',
    );
  });
});

describe('every line agrees with the module that owns its truth', () => {
  it('line 1 claims no less than the account deck already refuses', () => {
    // Lines 1 and 2 used to be pinned only against THEMSELVES, which is the
    // one thing a per-line verdict table cannot afford: the whole point of
    // the table is that a reworded module takes this page red before the
    // page becomes a lie. `registration.ts`'s "the keypair IS the account"
    // is a comment; the shipped sentence a person can read beside this one
    // is `recoverExplain[0]`, and that is what line 1 is measured against.
    expect(ACCOUNTS_COPY.recoverExplain[0]).toMatch(/no copy of your keys/i);
    expect(ACCOUNTS_COPY.recoverExplain[0]).toMatch(
      /nothing more it could give back/i,
    );
    expect(LOSS_COPY.lines[0]).toContain('has never left');
    expect(LOSS_COPY.lines[0]).toContain(
      'nobody at Tacendum can bring it back, because we never had it',
    );
  });

  it('line 2 says what the safety deck says: a new device is a new contact', () => {
    // In `safety.ts` this is load-bearing — it is the ARGUMENT for refusing
    // the innocent reading of a changed safety number. Line 2 restates it as
    // a cost, so it must not outlive it: if the changed-number body were
    // ever reworded to allow "they reinstalled", this goes red here first.
    expect(SAFETY_COPY.changed.body('Ada')).toContain(
      'a new contact with a new ID',
    );
    expect(SAFETY_EXPLAINER[1]).toContain('a NEW contact with a new ID');
    expect(LOSS_COPY.lines[1]).toContain(
      'To reach them again you would be someone new, and they would add you again',
    );
  });

  it('line 3 claims exactly the two things the shipped recovery scope claims', () => {
    // `accountsCopy.recoverScope` is the R-P10 sentence, and it says "two
    // things only". This page must not add a third — a username clause was
    // drafted and CUT here for exactly that reason.
    expect(ACCOUNTS_COPY.recoverScope).toContain('two things only');
    // The first thing is named the way the site and both store listings name
    // it ("which devices are yours"), never as a bare "your account": the key
    // IS the account (RegisterScreen), and no recovery brings a key back.
    expect(ACCOUNTS_COPY.recoverScope).toContain(
      'two things only: which devices are yours, and your findability',
    );
    expect(LOSS_COPY.lines[2]).toContain(
      'which devices are yours, and being findable by that email',
    );
    expect(ACCOUNTS_COPY.recoverScope).not.toMatch(/only: your account\b/);
    expect(LOSS_COPY.lines[2]).not.toMatch(/one: your account\b/);
    expect(ACCOUNTS_COPY.recoverScope).toContain('your findability by email');
    expect(ACCOUNTS_COPY.recoverScope).not.toMatch(/username/i);
    expect(LOSS_COPY.lines[2]).not.toMatch(/username/i);

    // …and the three refusals, each stated by the same sentence.
    expect(ACCOUNTS_COPY.recoverScope).toContain('Your messages are not here');
    expect(ACCOUNTS_COPY.recoverScope).toContain('Your old keys are not here');
    expect(ACCOUNTS_COPY.recoverScope).toContain('a new safety number');
  });

  it('line 4 claims no more than the linking deck already promises', () => {
    // The byte-pinned history stance (`link-ceremony.test.ts`): a linked
    // device starts at the link, not at the beginning. This page CITES it;
    // it does not reword it.
    expect(LINKING_COPY.historyStance).toBe(
      'This device shows messages from today forward.',
    );
    expect(LOSS_COPY.lines[3]).toContain('It is not a backup');
    expect(LOSS_COPY.lines[3]).toContain('it starts empty and fills from there');
  });

  it('nothing here offers a way back that does not exist', () => {
    const all = [...LOSS_COPY.lines, ...LOSS_COPY.infoLines].join(' ');
    expect(all).not.toMatch(/sign in again|sign out|restore your messages/i);
    expect(all).not.toMatch(/\bbackup\b(?!\s—)/i);
  });
});

describe('the sweeps this deck is written to pass', () => {
  const all = [
    LOSS_COPY.row,
    LOSS_COPY.title,
    LOSS_COPY.infoLabel,
    ...LOSS_COPY.lines,
    ...LOSS_COPY.infoLines,
  ];

  it('names no device, so it owes no inventory row and no pin bump', () => {
    for (const line of all) {
      expect(line).not.toMatch(/iphone|ipad|icloud|apple|tablet/i);
      expect(line).not.toMatch(/\bphones?\b(?!\s(?:call|number))/i);
    }
  });

  it('carries no capture word the App Lock vocabulary refuses', () => {
    for (const line of all) {
      expect(line).not.toMatch(/\bsecret\b|\bhidden\b|\bstealth\b/i);
    }
  });

  it('the sweeps really sweep — the same predicates reject planted lines', () => {
    expect(all.length).toBe(8);
    expect('a key on this iPhone').toMatch(/iphone|ipad|icloud|apple|tablet/i);
    expect('a key on this phone').toMatch(/\bphones?\b(?!\s(?:call|number))/i);
    expect('a hidden workspace').toMatch(/\bsecret\b|\bhidden\b|\bstealth\b/i);
    // …and a phone CALL is still allowed to be a phone call.
    expect('on a phone call').not.toMatch(/\bphones?\b(?!\s(?:call|number))/i);
  });
});
