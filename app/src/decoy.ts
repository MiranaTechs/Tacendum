import { randomBytes } from 'tacendum-crypto';
import { EMOJI, FIRST_NAMES, LAST_NAMES, SYLLABLES } from './decoy-corpus';
import * as db from './db';
import { encodeEnvelope, previewFor } from './envelope';
import { session } from './session';

/**
 * Decoy workspace generator. Runs in the REAL session at
 * passcode setup; writes only to the decoy file over its own short-lived
 * connection. Inputs are platform randomness and the bundled corpus — never
 * the real workspace. The one sanctioned real datum is the user's
 * own profile row: a decoy that renames YOU is the implausibility
 * that unravels the act.
 *
 * The randomness here is cosmetic (it invents fake names, not secrets), but
 * it still comes from SecRandomCopyBytes — there is no reason to introduce a
 * second, weaker source.
 */

export type Rng = () => number;

export interface DecoyMessage {
  body: string;
  direction: 'in' | 'out';
  ts: number;
}

export interface DecoyReaction {
  /** Index into the chat's messages array. */
  targetIndex: number;
  /** Who reacted: 'out' = me, 'in' = the fake peer. */
  direction: 'in' | 'out';
  emoji: string;
  ts: number;
}

/**
 * One item in a decoy Room's vault.
 *
 * An EMPTY decoy vault is a mild tell: a phone whose owner uses the feature has
 * items in some Rooms, and a coercer who knows the product knows that. The plan
 * asked for this to be decided rather than left, and this is the decision —
 * texture, at the same low frequency real use has, in the same invented
 * alphabet as everything else here.
 *
 * `writerId` is a real column of `vault_items` and it is BOTH sides in a real
 * Room, so some items are written by the fake peer and some by me. A decoy
 * whose every item had one writer would differ structurally from a real one.
 */
export interface DecoyVaultItem {
  id: string;
  title: string;
  body: string;
  /** 'me' becomes my own account id at write time; 'peer' the fake peer's. */
  writer: 'me' | 'peer';
  seq: number;
  ackSeq: number;
  updatedAt: number;
}

export interface DecoyChat {
  peerId: string;
  displayName: string;
  messages: DecoyMessage[];
  reactions: DecoyReaction[];
  vault: DecoyVaultItem[];
}

/**
 * One fabricated Room. An EMPTY rooms list once rooms
 * ship is the same tell class as an empty vault, and
 * rule 16 forbids it: the person this phone claims to be uses group chats
 * everywhere else, so the decoy fabricates at least one — column for column
 * with the four real tables, exactly as `vault_items` is fabricated below.
 *
 * `'me'` is a placeholder resolved to my own account id at write time, the
 * one sanctioned real datum — same convention as DecoyVaultItem.
 */

/** One `group_members` slot. Only the two real lanes ever appear: writerId
 * is the owner (authority) or the member themself (sovereign) — a third
 * lane would be a row the real apply path can never store. */
export interface DecoyRoomSlot {
  memberId: 'me' | string;
  writerId: 'me' | string;
  seq: number;
  state: 'in' | 'out';
  updatedAt: number;
}

/**
 * One membership-machinery row of the room's thread. A real room's history
 * is not only speech: the accepted `grp.new` and every applied roster or
 * timer write is a stored, attributed `messages` row ("Ana started this
 * room.", "Ana added Ben."), and a thread whose slots record a mid-life
 * add with no announcement row anywhere would contradict itself. So the
 * fabrication emits the event rows its slots imply, and nothing else.
 */
export interface DecoyRoomEvent {
  tcm: 'grp.new' | 'grp.roster' | 'grp.set';
  writer: 'me' | string;
  /** grp.roster only: the member acted on. */
  member?: 'me' | string;
  /** grp.roster only. */
  state?: 'in' | 'out';
  /** grp.set only: seconds, 0 = off. */
  seconds?: number;
  /** The WRITER's own per-room counter value for this write. */
  seq: number;
  ts: number;
  /** writer 'me': the local half of a `${selfId}.${id}` row id, as the
   * send path mints. Anyone else: the whole inbound wire id. */
  msgId: string;
}

export interface DecoyRoomMessage {
  author: 'me' | string;
  body: string;
  ts: number;
  /** The author's own per-room message counter (`messages.sq`). */
  sq: number;
  /** ULID-shaped local id; the row id is `${authorId}.${id}`. */
  id: string;
}

export interface DecoyRoom {
  groupId: string;
  name: string;
  owner: 'me' | string;
  /** The founding roster, owner and me included — the `ms` of the grp.new. */
  founders: ('me' | string)[];
  slots: DecoyRoomSlot[];
  settings: { writerId: 'me' | string; seq: number; disappearSec: number }[];
  events: DecoyRoomEvent[];
  messages: DecoyRoomMessage[];
  /** MY OWN `group_counters` rows, derived from the writes above: a phone
   * that has sent in a room but holds no counter would be one bad shape. */
  counters: { scope: 'writer' | 'msg'; seq: number }[];
}

export interface DecoyData {
  chats: DecoyChat[];
  rooms: DecoyRoom[];
}

// The decoy file itself is opened only through db.openDecoyConnection() —
// the one seam that also keeps it out of the device backup — so its name
// lives in db.ts's WORKSPACE_FILES, not here. A second copy of the name next
// to a second `open()` call is exactly how the backup gap happened.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Newest decoy activity is kept this recent — at generation and on every
 * duress unlock (freshness drift). */
const FRESH_MIN_MS = 10 * MINUTE;
const FRESH_SPAN_MS = 110 * MINUTE;

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function between(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** One garbled utterance: pseudo-words, occasionally an emoji or a
 * cipher-looking line (the brand aesthetic, at low frequency). */
export function garbleSentence(rng: Rng): string {
  const kind = rng();
  if (kind < 0.06) return pick(rng, EMOJI);
  if (kind < 0.11) {
    const groups = 2 + Math.floor(rng() * 3);
    const hex = '0123456789abcdef';
    const group = () => {
      const len = 2 + Math.floor(rng() * 3);
      let out = '';
      for (let i = 0; i < len; i++) out += hex[Math.floor(rng() * hex.length)];
      return out;
    };
    return Array.from({ length: groups }, group).join('·');
  }
  const wordCount = 1 + Math.floor(rng() ** 1.6 * 9);
  const words: string[] = [];
  for (let w = 0; w < wordCount; w++) {
    const syllables = 1 + Math.floor(rng() * 3);
    let word = '';
    for (let s = 0; s < syllables; s++) word += pick(rng, SYLLABLES);
    words.push(word);
  }
  if (rng() < 0.3) {
    words[words.length - 1] += pick(rng, ['.', '!', '?', '…']);
  }
  if (rng() < 0.08) words.push(pick(rng, EMOJI));
  return words.join(' ');
}

function fakePeerId(rng: Rng): string {
  let id = '';
  for (let i = 0; i < 26; i++) {
    id += CROCKFORD[Math.floor(rng() * CROCKFORD.length)];
  }
  return id;
}

/** Invent the whole decoy world. Pure: same rng walk, same world. */
export function generateDecoyData(rng: Rng, now: number): DecoyData {
  const chatCount = 6 + Math.floor(rng() * 4);
  const firstNames = [...FIRST_NAMES];
  const chats: DecoyChat[] = [];

  for (let c = 0; c < chatCount; c++) {
    // Unique first names across chats, like a real contact list.
    const nameIndex = Math.floor(rng() * firstNames.length);
    const first = firstNames.splice(nameIndex, 1)[0];
    const displayName =
      rng() < 0.6 ? `${first} ${pick(rng, LAST_NAMES)}` : first;

    const messageCount = 8 + Math.floor(rng() * 21);
    // Newest message of this chat lands between 15 minutes and 14 days ago;
    // earlier messages walk backwards with small-gap-skewed spacing.
    let ts = now - between(rng, 15 * MINUTE, 14 * DAY);
    const reversed: DecoyMessage[] = [];
    let direction: 'in' | 'out' = rng() < 0.5 ? 'in' : 'out';
    for (let m = 0; m < messageCount; m++) {
      reversed.push({ body: garbleSentence(rng), direction, ts });
      ts -= between(rng, 2 * MINUTE, 26 * HOUR) * rng();
      if (rng() > 0.55) direction = direction === 'in' ? 'out' : 'in';
    }
    const messages = reversed.reverse();

    const reactions: DecoyReaction[] = [];
    if (rng() < 0.25 && messages.length > 5) {
      const targetIndex =
        messages.length - 1 - Math.floor(rng() * Math.min(5, messages.length));
      const target = messages[targetIndex];
      reactions.push({
        targetIndex,
        direction: target.direction === 'in' ? 'out' : 'in',
        emoji: pick(rng, EMOJI),
        ts: target.ts + 90_000,
      });
    }

    // A vault in EVERY Room would be as much of a tell as a vault in none, so
    // it is roughly one conversation in three, one or two items each — the
    // shape of a feature people use for the handful of things worth keeping.
    const vault: DecoyVaultItem[] = [];
    if (rng() < 0.34) {
      const items = 1 + Math.floor(rng() * 2);
      for (let v = 0; v < items; v++) {
        // Timestamps sit inside this chat's own span rather than at `now`: an
        // item newer than every message in the Room it belongs to reads as
        // planted. Drifted with everything else below and on every unlock.
        const seq = 1 + Math.floor(rng() * 4);
        vault.push({
          id: fakePeerId(rng), // a ULID-shaped id, minted the same way
          title: garbleTitle(rng),
          body: garbleCredential(rng),
          writer: rng() < 0.5 ? 'me' : 'peer',
          seq,
          // A believable causal history: they had seen some of my writes.
          ackSeq: Math.floor(rng() * seq),
          updatedAt: messages[Math.floor(rng() * messages.length)].ts,
        });
      }
    }

    chats.push({
      peerId: fakePeerId(rng),
      displayName,
      messages,
      reactions,
      vault,
    });
  }

  // At least one Room, occasionally two: a person whose
  // every 1:1 contact is chatty but who is in NO group would read as staged
  // to anyone who knows the product — the same argument as the vault above.
  const rooms: DecoyRoom[] = [];
  const roomCount = 1 + (rng() < 0.35 ? 1 : 0);
  for (let r = 0; r < roomCount; r++) {
    rooms.push(generateDecoyRoom(rng, chats.map(c => c.peerId), now));
  }

  // Uniform shift so the newest activity across all chats sits 10-120
  // minutes in the past — the decoy always looks recently alive. Rooms ride
  // the same shift: their rows land in the same `messages` table, so a
  // second clock for them would let the two drift apart.
  const newest = Math.max(
    ...chats.flatMap(c => c.messages.map(m => m.ts)),
    ...rooms.flatMap(room => room.messages.map(m => m.ts)),
    ...rooms.flatMap(room => room.events.map(e => e.ts)),
  );
  const delta = now - between(rng, FRESH_MIN_MS, FRESH_MIN_MS + FRESH_SPAN_MS) - newest;
  for (const chat of chats) {
    for (const message of chat.messages) message.ts += delta;
    for (const reaction of chat.reactions) reaction.ts += delta;
    for (const item of chat.vault) item.updatedAt += delta;
  }
  for (const room of rooms) {
    for (const message of room.messages) message.ts += delta;
    for (const event of room.events) event.ts += delta;
    // Slots move with the event rows that announced them: an "Ana added Ben"
    // row whose slot was applied days away from it would be its own tell.
    for (const slot of room.slots) slot.updatedAt += delta;
  }
  return { chats, rooms };
}

/**
 * Invent one plausible Room, column for column with what
 * the real accept/send paths leave behind — the anchor, owner-lane slots
 * sharing the grp.new's single seq, the machinery rows the slots imply, and
 * attributed messages from several speakers.
 *
 * Members come from MY OWN fabricated chats: real rooms are made of people
 * you also talk to, and it is what lets the thread render their names — the
 * UI resolves an author through my chats and falls back to an id fragment.
 * Occasionally one member is someone never messaged 1:1, because that
 * happens too and the id-fragment fallback is the real behaviour.
 *
 * The OWNER is sometimes me and sometimes not: a person who created every
 * room they are in is its own small implausibility.
 */
function generateDecoyRoom(
  rng: Rng,
  peers: readonly string[],
  now: number,
): DecoyRoom {
  const groupId = fakePeerId(rng);
  const name = garbleTitle(rng);

  const pool = [...peers];
  const founders: ('me' | string)[] = ['me'];
  const fromChats = Math.min(2 + Math.floor(rng() * 3), pool.length);
  for (let i = 0; i < fromChats; i++) {
    founders.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  if (rng() < 0.25) founders.push(fakePeerId(rng)); // never DM'd
  const owner: 'me' | string =
    rng() < 0.45 ? 'me' : pick(rng, founders.filter(f => f !== 'me'));

  // The room's optional later life, decided up front so the walk below can
  // interleave the announcement rows exactly where the slots say they were:
  // a member added mid-life, a member who left, a timer toggled on and off.
  // Each at roughly the frequency the vault uses — texture, not a checklist.
  const lateCandidate = founders[founders.length - 1];
  const late =
    founders.length >= 4 &&
    lateCandidate !== owner &&
    lateCandidate !== 'me' &&
    rng() < 0.35
      ? lateCandidate
      : null;
  // The grp.new's `ms` — what makes the late member late is precisely that
  // this list never carried them. They exist in the room only if their add
  // event actually lands inside the walk below.
  const foundersOnly = founders.filter(f => f !== late);
  const leaveCandidates = foundersOnly.filter(f => f !== 'me' && f !== owner);
  const leaver =
    leaveCandidates.length > 0 && rng() < 0.3
      ? pick(rng, leaveCandidates)
      : null;
  const timerWriter =
    rng() < 0.2
      ? pick(rng, foundersOnly.filter(f => f !== leaver))
      : null;

  // Per-writer counters: each writer numbers their own membership
  // and settings writes; each author numbers their own messages.
  const writerSeq = new Map<'me' | string, number>();
  const nextWriterSeq = (w: 'me' | string): number => {
    const n = (writerSeq.get(w) ?? 0) + 1;
    writerSeq.set(w, n);
    return n;
  };
  const msgSeq = new Map<'me' | string, number>();

  const events: DecoyRoomEvent[] = [];
  const messages: DecoyRoomMessage[] = [];
  const slots: DecoyRoomSlot[] = [];
  const settings: DecoyRoom['settings'] = [];

  const createdAt = now - between(rng, 5 * DAY, 18 * DAY);
  events.push({
    tcm: 'grp.new',
    writer: owner,
    seq: nextWriterSeq(owner),
    ts: createdAt,
    msgId: fakePeerId(rng),
  });
  // The accept writes every founding slot in ONE transaction, so they share
  // one applied-at instant — per-slot jitter here would be the giveaway.
  // On the creator's own phone that instant is the compose; on anyone
  // else's, the delivery a little later.
  const anchorAppliedAt =
    owner === 'me' ? createdAt : createdAt + between(rng, 1_000, 10 * MINUTE);
  for (const f of foundersOnly) {
    // The grp.new carries ONE n for its whole member list, so every founding
    // owner-lane slot shares seq 1 — including the owner's own merged row
    // (memberId = writerId = ownerId), which is deliberately a single row.
    slots.push({
      memberId: f,
      writerId: owner,
      seq: 1,
      state: 'in',
      updatedAt: anchorAppliedAt,
    });
  }

  const budget = 8 + Math.floor(rng() * 21);
  const addAt = late ? 2 + Math.floor(budget * between(rng, 0.25, 0.55)) : -1;
  const leaveAt = leaver
    ? Math.max(addAt + 1, Math.floor(budget * between(rng, 0.6, 0.9)))
    : -1;
  const timerAt = timerWriter
    ? 1 + Math.floor(budget * between(rng, 0.2, 0.7))
    : -1;

  const ceiling = now - 15 * MINUTE;
  let ts = createdAt + between(rng, 2 * MINUTE, 6 * HOUR);
  // Openers: three distinct founding voices, so even the shortest room is
  // several speakers rather than a monologue.
  const openers: ('me' | string)[] = [];
  {
    const candidates = [...foundersOnly];
    while (openers.length < 3 && candidates.length > 0) {
      openers.push(candidates.splice(Math.floor(rng() * candidates.length), 1)[0]);
    }
  }
  let author: 'me' | string = openers[0];
  for (let i = 0; i < budget && ts < ceiling; i++) {
    if (i === addAt && late) {
      events.push({
        tcm: 'grp.roster',
        writer: owner,
        member: late,
        state: 'in',
        seq: nextWriterSeq(owner),
        ts,
        msgId: fakePeerId(rng),
      });
      slots.push({
        memberId: late,
        writerId: owner,
        seq: writerSeq.get(owner)!,
        state: 'in',
        updatedAt: ts,
      });
      ts += between(rng, 2 * MINUTE, 26 * HOUR) * rng() + between(rng, 5_000, 60_000);
    }
    if (i === leaveAt && leaver) {
      // The sovereign self lane: the leave is the leaver's own
      // write, numbered by THEIR counter — their first-ever write is seq 1.
      events.push({
        tcm: 'grp.roster',
        writer: leaver,
        member: leaver,
        state: 'out',
        seq: nextWriterSeq(leaver),
        ts,
        msgId: fakePeerId(rng),
      });
      slots.push({
        memberId: leaver,
        writerId: leaver,
        seq: writerSeq.get(leaver)!,
        state: 'out',
        updatedAt: ts,
      });
      ts += between(rng, 2 * MINUTE, 26 * HOUR) * rng() + between(rng, 5_000, 60_000);
    }
    if (i === timerAt && timerWriter) {
      // A timer toggled on and then off, minutes apart, with no messages in
      // the window: the announced pair plus a disappearSec=0 slot is the
      // residue a real fiddle leaves. (A LIVE timer is not fabricable
      // honestly — every later message would need the expiry stamp the send
      // path would have given it, and a NULL there is a cheaper probe than
      // the empty table this function exists to fill.)
      const on = nextWriterSeq(timerWriter);
      events.push({
        tcm: 'grp.set',
        writer: timerWriter,
        seconds: pick(rng, [3_600, 86_400, 604_800]),
        seq: on,
        ts,
        msgId: fakePeerId(rng),
      });
      const offTs = ts + between(rng, 2 * MINUTE, 3 * HOUR);
      events.push({
        tcm: 'grp.set',
        writer: timerWriter,
        seconds: 0,
        seq: nextWriterSeq(timerWriter),
        ts: offTs,
        msgId: fakePeerId(rng),
      });
      settings.push({
        writerId: timerWriter,
        seq: writerSeq.get(timerWriter)!,
        disappearSec: 0,
      });
      ts = offTs + between(rng, 2 * MINUTE, 26 * HOUR) * rng() + between(rng, 5_000, 60_000);
    }
    const speakers = [...foundersOnly, ...(late !== null ? [late] : [])].filter(
      f => (f !== late || i >= addAt) && (f !== leaver || i < leaveAt),
    );
    if (i < openers.length) {
      author = openers[i];
    } else if (!speakers.includes(author) || rng() > 0.55) {
      author = pick(rng, speakers);
    }
    const sq = (msgSeq.get(author) ?? 0) + 1;
    msgSeq.set(author, sq);
    messages.push({
      author,
      body: garbleSentence(rng),
      ts,
      sq,
      id: fakePeerId(rng),
    });
    ts += between(rng, 2 * MINUTE, 26 * HOUR) * rng() + between(rng, 5_000, 60_000);
  }

  // MY OWN allocators, and only mine — everyone else's counters live on
  // their phones. Absent when I never wrote, exactly as the real table is.
  const counters: DecoyRoom['counters'] = [];
  const myWriter = writerSeq.get('me') ?? 0;
  if (myWriter > 0) counters.push({ scope: 'writer', seq: myWriter });
  const myMsg = msgSeq.get('me') ?? 0;
  if (myMsg > 0) counters.push({ scope: 'msg', seq: myMsg });

  return {
    groupId,
    name,
    owner,
    founders: foundersOnly,
    slots,
    settings,
    events,
    messages,
    counters,
  };
}

/** A short label, in the same invented alphabet as everything else — one or
 * two pseudo-words, never a sentence, because that is what a vault title is. */
function garbleTitle(rng: Rng): string {
  const words = 1 + Math.floor(rng() * 2);
  const out: string[] = [];
  for (let w = 0; w < words; w++) {
    const syllables = 1 + Math.floor(rng() * 2);
    let word = '';
    for (let s = 0; s < syllables; s++) word += pick(rng, SYLLABLES);
    out.push(word);
  }
  return out.join(' ');
}

/** A credential-SHAPED string: the point is the shape, not the words. A vault
 * body that read like conversation would be the tell the emptiness was. */
function garbleCredential(rng: Rng): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const groups = 2 + Math.floor(rng() * 3);
  const group = () => {
    const len = 4 + Math.floor(rng() * 2);
    let out = '';
    for (let i = 0; i < len; i++) {
      out += alphabet[Math.floor(rng() * alphabet.length)];
    }
    return out;
  };
  return Array.from({ length: groups }, group).join('-');
}

/** Persist a generated world into the decoy file (clearing any previous
 * one), plus the single sanctioned copy of my own profile row. */
export async function writeDecoy(
  data: DecoyData,
  me: db.ProfileRow,
): Promise<void> {
  const d = db.openDecoyConnection();
  try {
    await db.initSchema(d);
    for (const table of db.DB_TABLES) {
      await d.execute(`DELETE FROM ${table}`);
    }
    // The sanctioned copy, key for key with `db.saveProfile`. The phone
    // number that used to ride along is gone with the account model that had
    // one — and its absence COSTS the decoy
    // nothing, because plausibility here means the decoy's Your-profile screen
    // is indistinguishable from the real one, and the real one no longer shows
    // a number either. Writing a stale number would be the tell, not omitting
    // it. Keep this list in step with saveProfile: a key written here and not
    // there (or the reverse) is a decoy whose profile differs from the real
    // one, which is exactly what the design forbids.
    for (const [key, value] of [
      ['userId', me.userId],
      ['registrationId', String(me.registrationId)],
      ['displayName', me.displayName],
      ['about', me.about],
      ['avatarB64', me.avatarB64],
      ['profileVersion', String(me.profileVersion)],
    ]) {
      await d.execute(
        `INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)`,
        [key, value],
      );
    }
    for (const [chatIndex, chat] of data.chats.entries()) {
      const last = chat.messages[chat.messages.length - 1];
      await d.execute(
        `INSERT INTO chats (peerId, displayName, lastMessageAt, lastMessageText)
         VALUES (?, ?, ?, ?)`,
        [chat.peerId, chat.displayName, last.ts, last.body],
      );
      for (const [i, message] of chat.messages.entries()) {
        await d.execute(
          `INSERT INTO messages (msgId, peerId, direction, body, ts, status)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            decoyMsgId(chatIndex, i),
            chat.peerId,
            message.direction,
            message.body,
            message.ts,
            message.direction === 'in' ? 'received' : 'delivered',
          ],
        );
      }
      for (const item of chat.vault) {
        // Column for column with the real table, including `writerId` — a decoy
        // vault whose rows had a different SHAPE from a real one would be a
        // cheap probe, which is exactly what rule 16 forbids. `me.userId` is
        // the sanctioned real datum the design already lets cross; it is the same id
        // the decoy's own profile row carries, so the two agree.
        await d.execute(
          `INSERT INTO vault_items
             (peerId, id, writerId, seq, ackSeq, title, body, updatedAt, deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          [
            chat.peerId,
            item.id,
            item.writer === 'me' ? me.userId : chat.peerId,
            item.seq,
            item.ackSeq,
            item.title,
            item.body,
            item.updatedAt,
          ],
        );
      }
      for (const reaction of chat.reactions) {
        const target = chat.messages[reaction.targetIndex];
        await d.execute(
          `INSERT INTO reactions (targetMsgId, targetDirection, direction, emoji, ts)
           VALUES (?, ?, ?, ?, ?)`,
          [
            decoyMsgId(chatIndex, reaction.targetIndex),
            target.direction,
            reaction.direction,
            reaction.emoji,
            reaction.ts,
          ],
        );
      }
    }
    // Rooms: the four tables column for column with what
    // the real accept/send paths write, plus the room's chats row and thread.
    // `me.userId` is the same sanctioned real datum the vault writer uses —
    // it is the id the decoy's own profile row carries, so the two agree.
    for (const room of data.rooms) {
      const resolve = (who: 'me' | string): string =>
        who === 'me' ? me.userId : who;
      const ownerId = resolve(room.owner);
      // The anchor: written once, `distributionId` reserved NULL and
      // never written — exactly as loadGroupStore.persist() leaves it.
      await d.execute(
        `INSERT OR IGNORE INTO groups (groupId, ownerId, name)
         VALUES (?, ?, ?)`,
        [room.groupId, ownerId, room.name],
      );
      for (const slot of room.slots) {
        await d.execute(
          `INSERT OR REPLACE INTO group_members
             (groupId, memberId, writerId, seq, state, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            room.groupId,
            resolve(slot.memberId),
            resolve(slot.writerId),
            slot.seq,
            slot.state,
            slot.updatedAt,
          ],
        );
      }
      for (const slot of room.settings) {
        await d.execute(
          `INSERT OR REPLACE INTO group_settings
             (groupId, writerId, seq, disappearSec)
           VALUES (?, ?, ?, ?)`,
          [room.groupId, resolve(slot.writerId), slot.seq, slot.disappearSec],
        );
      }
      for (const counter of room.counters) {
        await d.execute(
          `INSERT INTO group_counters (groupId, scope, seq) VALUES (?, ?, ?)`,
          [room.groupId, counter.scope, counter.seq],
        );
      }
      // The machinery rows the slots imply, bodied by the REAL encoder so a
      // decoy announcement can never be a JSON shape parseEnvelope refuses.
      const eventBody = (event: DecoyRoomEvent): string => {
        if (event.tcm === 'grp.new') {
          return encodeEnvelope({
            tcm: 'grp.new',
            g: room.groupId,
            nm: room.name,
            ms: room.founders.map(resolve),
            n: event.seq,
          });
        }
        if (event.tcm === 'grp.roster') {
          return encodeEnvelope({
            tcm: 'grp.roster',
            g: room.groupId,
            m: resolve(event.member!),
            s: event.state!,
            n: event.seq,
          });
        }
        return encodeEnvelope({
          tcm: 'grp.set',
          g: room.groupId,
          s: event.seconds ?? 0,
          n: event.seq,
        });
      };
      let lastTs = 0;
      let lastPreview = '';
      for (const event of room.events) {
        const body = eventBody(event);
        const mine = event.writer === 'me';
        // Mine mirror fanOutMembership's parent row (`${selfId}.${id}`,
        // out, sq = the write's n); everyone else's mirror the receive
        // path's (the bare wire id, in, received, sq NULL).
        await d.execute(
          `INSERT INTO messages (msgId, peerId, direction, body, ts, status, authorId, sq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            mine ? `${me.userId}.${event.msgId}` : event.msgId,
            room.groupId,
            mine ? 'out' : 'in',
            body,
            event.ts,
            mine ? 'delivered' : 'received',
            resolve(event.writer),
            mine ? event.seq : null,
          ],
        );
        if (event.ts > lastTs) {
          lastTs = event.ts;
          lastPreview = previewFor(body) || body;
        }
      }
      for (const message of room.messages) {
        const authorId = resolve(message.author);
        const mine = message.author === 'me';
        // `${authorId}.${m}`: identical on every phone, which is the
        // row-key shape a real room message always has, in or out.
        await d.execute(
          `INSERT INTO messages (msgId, peerId, direction, body, ts, status, authorId, sq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `${authorId}.${message.id}`,
            room.groupId,
            mine ? 'out' : 'in',
            message.body,
            message.ts,
            mine ? 'delivered' : 'received',
            authorId,
            message.sq,
          ],
        );
        if (message.ts > lastTs) {
          lastTs = message.ts;
          lastPreview = previewFor(message.body) || message.body;
        }
      }
      // The room's conversation row, as persist()'s 'present' op plus the
      // touchChat every message performs leave it: kind='group', the
      // creator's name in groupName, displayName NULL (a room has no card
      // to broadcast), createdAt at the accept — the grp.new's moment.
      await d.execute(
        `INSERT INTO chats (peerId, lastMessageAt, lastMessageText, createdAt, kind, groupName)
         VALUES (?, ?, ?, ?, 'group', ?)`,
        [room.groupId, lastTs, lastPreview, room.events[0].ts, room.name],
      );
    }
  } finally {
    d.close();
  }
}

/** Sortable within a chat (listMessages orders by msgId). Decoy ids never
 * cross the wire; they only need to sort like the ULIDs the UI expects. */
function decoyMsgId(chatIndex: number, messageIndex: number): string {
  return `${String(chatIndex).padStart(2, '0')}D${String(messageIndex).padStart(4, '0')}`;
}

/** Real-session entry point: (re)generate the decoy world. Silent no-op in
 * a duress session — a coerced "reset decoy data" must change nothing. */
export async function setupDecoy(): Promise<void> {
  if (session.mode === 'duress') return;
  const me = await db.loadProfile();
  if (!me) throw new Error('no profile to build a decoy for');
  const rng = await makeRng();
  await writeDecoy(generateDecoyData(rng, Date.now()), me);
}

/** Keep the decoy's copy of my own profile current (real unlock). */
export async function syncDecoyProfile(): Promise<void> {
  if (session.mode === 'duress') return;
  const me = await db.loadProfile();
  if (!me) return;
  const d = db.openDecoyConnection();
  try {
    await db.initSchema(d);
    // Same key list as writeDecoy above, and for the same reason — the two
    // must not drift, or a re-sync would leave the decoy's profile half old.
    for (const [key, value] of [
      ['userId', me.userId],
      ['registrationId', String(me.registrationId)],
      ['displayName', me.displayName],
      ['about', me.about],
      ['avatarB64', me.avatarB64],
      ['profileVersion', String(me.profileVersion)],
    ]) {
      await d.execute(
        `INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)`,
        [key, value],
      );
    }
    // Unlike writeDecoy, this path does not clear the table first — it is a
    // re-sync, not a rebuild — so an older build's phone number would survive
    // here after `saveProfile` had already purged the real one, leaving the
    // real number in the DECOY file alone. Same one-liner, same reason.
    await d.execute(`DELETE FROM profile WHERE key = 'phone'`);
  } finally {
    d.close();
  }
}

/**
 * Freshness drift, run at duress unlock BEFORE the workspace opens:
 * shift every decoy timestamp forward by one uniform delta so the newest
 * message sits 10-120 minutes ago. Uniform → ordering and spacing preserved.
 * The jitter is derived from the stale timestamp itself — deterministic, no
 * RNG needed for a cosmetic offset. Never shifts backwards.
 */
export async function refreshDecoyTimestamps(
  now: number = Date.now(),
): Promise<void> {
  const d = db.openDecoyConnection();
  try {
    let newest: number | null = null;
    try {
      const res = await d.execute(
        `SELECT MAX(lastMessageAt) AS newest FROM chats`,
      );
      const row = res.rows[0] as { newest: number | null } | undefined;
      newest = row?.newest ?? null;
    } catch {
      return; // fresh file, no decoy yet — nothing to drift
    }
    if (newest == null) return;
    const target = now - FRESH_MIN_MS - (newest % FRESH_SPAN_MS);
    const delta = target - newest;
    if (delta <= 0) return; // already fresh; never move backwards
    await d.execute(`UPDATE messages SET ts = ts + ?`, [delta]);
    await d.execute(
      `UPDATE chats SET lastMessageAt = lastMessageAt + ?
       WHERE lastMessageAt IS NOT NULL`,
      [delta],
    );
    await d.execute(`UPDATE reactions SET ts = ts + ?`, [delta]);
    // The vault drifts with everything else. Left out, every
    // decoy vault item would keep the timestamp it was generated with while the
    // conversations around it stayed 10-120 minutes old — so the longer the
    // decoy went unrefreshed, the more obviously the two disagreed.
    await d.execute(`UPDATE vault_items SET updatedAt = updatedAt + ?`, [delta]);
    // Room slots drift for the vault's reason: a slot's
    // updatedAt is when THIS phone applied it, i.e. the moment of the
    // announcement row that carried it — the two must stay glued or every
    // refresh pulls the roster's clock further from the thread that
    // announced it. groups/group_settings/group_counters carry no clock.
    await d.execute(`UPDATE group_members SET updatedAt = updatedAt + ?`, [delta]);
    // createdAt drifts too. For a room it IS the accepted grp.new's moment,
    // which just moved; leaving it made the room predate its own creation
    // row a little more on every unlock. 1:1 rows keep the same relative
    // story (their createdAt is the backfill's lastMessageAt snapshot).
    await d.execute(
      `UPDATE chats SET createdAt = createdAt + ? WHERE createdAt IS NOT NULL`,
      [delta],
    );
  } finally {
    d.close();
  }
}

/** Cosmetic randomness from the platform RNG: an up-front pool (drawn in
 * chunks — the native module caps randomBytes at 4096 per call), consumed
 * linearly and wrapping if a very large world exhausts it — acceptable for
 * name-picking, documented; never used for anything secret. */
async function makeRng(): Promise<Rng> {
  const chunks: Uint8Array[] = [];
  for (let c = 0; c < 4; c++) chunks.push(await randomBytes(4096));
  const pool = new Uint8Array(chunks.reduce((n, ch) => n + ch.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    pool.set(chunk, offset);
    offset += chunk.length;
  }
  let i = 0;
  return () => pool[i++ % pool.length] / 256;
}
