/**
 * The CLI's room state — one JSON file per room, behind the SHARED apply
 * interface.
 *
 * `GroupSlotStore` is deliberately platform-neutral and says so in its own
 * doc: "the `chats` row on the phone, the room file in the CLI". The app
 * implements it over SQLite; this implements it over a file. Neither the fold
 * nor any apply function learns which, which is the whole point — a roster
 * that converged differently on the two clients would be a divergence no
 * amount of protocol work could fix, and the only structural defence is that
 * there is exactly ONE implementation of the rules.
 *
 * So this file holds no rules. It stores and it returns; every decision about
 * who may write what belongs to `@tacendum/shared/group-fold`.
 *
 * WHERE THE FILE LIVES: `stateDir()`, not `clientDir()`. A room's roster is
 * chat state, not a protocol secret — the same split `msglog` already argues
 * for, so that copying the key directory never silently copies conversation.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  RosterSlot,
  SettingsSlot,
  type GroupSlotStore,
} from '@tacendum/shared/group-fold';
import { z } from 'zod';
import { writeFileAtomic } from './atomic-write.js';
import { stateDir } from './config.js';

/** ULID, matching the wire's own rule so a malformed id cannot name a file. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * The on-disk shape. Parsed on every load rather than trusted: this file is
 * plain JSON in a directory a user can edit, and a hand-mangled slot reaching
 * the fold would be a rule violation wearing valid types. Permissive at the
 * SLOT level and strict at the file level — one corrupt slot is dropped, the
 * rest of the room survives, because losing a whole room to one bad line is
 * worse than losing one slot.
 */
const RoomFile = z.object({
  ownerId: z.string().regex(ULID).optional(),
  name: z.string().nullable().default(null),
  present: z.boolean().default(true),
  slots: z.array(z.unknown()).default([]),
  settings: z.array(z.unknown()).default([]),
});

export interface RoomSnapshot {
  groupId: string;
  ownerId: string | undefined;
  name: string | null;
  present: boolean;
}

function roomsDir(client: string): string {
  return join(stateDir(client), 'rooms');
}

function roomPath(client: string, groupId: string): string {
  if (!ULID.test(groupId)) {
    // Never interpolate an unvalidated id into a path. A group id arrives
    // from the wire, and `../` in one would be a file write outside the
    // compartment — the id is a ULID everywhere else by schema, so refusing
    // here costs nothing and closes the traversal whole.
    throw new Error(`not a room id: ${groupId}`);
  }
  return join(roomsDir(client), `${groupId}.json`);
}

/**
 * One room, loaded. Mutations are in memory; `persist()` is the only write,
 * so an apply that throws part-way leaves the file exactly as it was.
 *
 * That ordering matters more here than on the phone: the app's store commits
 * inside a SQLite transaction, and this has no transaction to fall back on.
 * Load, mutate, write-once is the same guarantee reached a different way.
 */
export class FileGroupStore implements GroupSlotStore {
  private owner: string | undefined;
  private name: string | null;
  private present: boolean;
  private slots: RosterSlot[];
  private settings: SettingsSlot[];
  private cleared = false;

  private constructor(
    private readonly client: string,
    readonly groupId: string,
    file: z.infer<typeof RoomFile>,
  ) {
    this.owner = file.ownerId;
    this.name = file.name;
    this.present = file.present;
    // Drop what does not parse rather than refusing the room. A slot this
    // build cannot read is a slot it cannot honour either way; keeping the
    // room readable is the recoverable outcome.
    this.slots = file.slots.flatMap(s => {
      const parsed = RosterSlot.safeParse(s);
      return parsed.success ? [parsed.data] : [];
    });
    this.settings = file.settings.flatMap(s => {
      const parsed = SettingsSlot.safeParse(s);
      return parsed.success ? [parsed.data] : [];
    });
  }

  static load(client: string, groupId: string): FileGroupStore {
    const path = roomPath(client, groupId);
    let raw: unknown = {};
    try {
      raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
      // Absent OR unreadable both mean "this client holds no such room",
      // which is exactly what an undefined owner says to the fold. A room
      // the apply layer then anchors will overwrite the unreadable file.
      raw = {};
    }
    const parsed = RoomFile.safeParse(raw);
    return new FileGroupStore(
      client,
      groupId,
      parsed.success ? parsed.data : RoomFile.parse({}),
    );
  }

  // --- GroupSlotStore -------------------------------------------------------

  getOwner(): string | undefined {
    return this.owner;
  }

  setOwner(ownerId: string): void {
    this.owner = ownerId;
  }

  getSlot(memberId: string, writerId: string): RosterSlot | undefined {
    return this.slots.find(
      s => s.memberId === memberId && s.writerId === writerId,
    );
  }

  putSlot(slot: RosterSlot): void {
    const i = this.slots.findIndex(
      s => s.memberId === slot.memberId && s.writerId === slot.writerId,
    );
    if (i >= 0) this.slots[i] = slot;
    else this.slots.push(slot);
  }

  deleteSlot(memberId: string, writerId: string): void {
    this.slots = this.slots.filter(
      s => !(s.memberId === memberId && s.writerId === writerId),
    );
  }

  listSlots(): readonly RosterSlot[] {
    return this.slots;
  }

  getSettingsSlot(writerId: string): SettingsSlot | undefined {
    return this.settings.find(s => s.writerId === writerId);
  }

  putSettingsSlot(slot: SettingsSlot): void {
    const i = this.settings.findIndex(s => s.writerId === slot.writerId);
    if (i >= 0) this.settings[i] = slot;
    else this.settings.push(slot);
  }

  listSettingsSlots(): readonly SettingsSlot[] {
    return this.settings;
  }

  isPresent(): boolean {
    return this.present;
  }

  setPresent(present: boolean): void {
    this.present = present;
  }

  clear(): void {
    // The FULL purge: anchor, every slot, every settings slot, presence.
    // The file is removed at persist rather than here, so a throw between
    // the two leaves the room intact rather than half-erased.
    this.owner = undefined;
    this.name = null;
    this.slots = [];
    this.settings = [];
    this.present = false;
    this.cleared = true;
  }

  // --- persistence ----------------------------------------------------------

  /** The room's display name. Not part of the fold's seam. */
  getName(): string | null {
    return this.name;
  }

  setName(name: string | null): void {
    this.name = name;
  }

  persist(): void {
    if (this.cleared) {
      // A purged room leaves no file. `rmSync` with force so a purge is
      // idempotent — replaying a counted grp.del must not throw on the
      // second pass (later traffic is discarded quietly).
      rmSync(roomPath(this.client, this.groupId), { force: true });
      return;
    }
    mkdirSync(roomsDir(this.client), { recursive: true, mode: 0o700 });
    writeFileAtomic(
      roomPath(this.client, this.groupId),
      `${JSON.stringify(
        {
          ownerId: this.owner,
          name: this.name,
          present: this.present,
          slots: this.slots,
          settings: this.settings,
        },
        null,
        2,
      )}\n`,
    );
  }

  snapshot(): RoomSnapshot {
    return {
      groupId: this.groupId,
      ownerId: this.owner,
      name: this.name,
      present: this.present,
    };
  }
}

/** Every room this client holds, newest id last (ULIDs sort chronologically). */
export function listRooms(client: string): RoomSnapshot[] {
  let names: string[] = [];
  try {
    names = readdirSync(roomsDir(client));
  } catch {
    // No rooms directory means no rooms — not an error worth surfacing.
    return [];
  }
  return names
    .filter(n => n.endsWith('.json'))
    .map(n => n.slice(0, -'.json'.length))
    .filter(id => ULID.test(id))
    .sort()
    .map(id => FileGroupStore.load(client, id).snapshot())
    // A room whose anchor never landed is not a room this client holds.
    .filter(r => r.ownerId !== undefined);
}
