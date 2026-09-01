import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Three defects in main.ts/mcp.ts, each of
 * which fails SILENTLY: a stale prekey batch the server happily serves, a
 * dropped message word behind exit 0, and an empty inbox reported as success.
 * Silent is why each needs a pinned test rather than a fix alone.
 *
 * The register and pair tests use a REAL child process against a local mock
 * API, because the properties under test live across the process's network
 * round trips: what the wire carries, and what is held while it is carried.
 * An in-process test could not see either without exporting private command
 * functions, and main.ts self-executes on import.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-gate-main-'));
process.env.TACENDUM_HOME = home;

const { saveProfile } = await import('../src/profile.js');
const { MessageLog } = await import('../src/msglog.js');
const { McpServer } = await import('../src/mcp.js');
type MessageRecord = import('../src/msglog.js').MessageRecord;

const PEER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const REG_USER_ID = '01REGB0TREGB0TREGB0TREGB0T';

/**
 * A lock path is a DIRECTORY and a holder is a single-use entry inside it, named
 * `<12-digit seq>.<32-hex nonce>`; the dot-prefixed staging file is not one.
 * The directory is the waiting room: it is created on first use and NEVER
 * removed, so `existsSync(lockPath)` is true forever afterwards and answers
 * nothing about who holds the lock. Only the entries answer that.
 *
 * The shape is duplicated rather than imported: a test that reads the rule off
 * the code under test cannot catch the code changing the rule.
 */
const ENTRY_RE = /^\d{12}\.[0-9a-f]{32}$/;

/** Is anybody holding this lock RIGHT NOW? */
function lockIsHeld(lockPath: string): boolean {
  try {
    return readdirSync(lockPath).some((name) => ENTRY_RE.test(name));
  } catch {
    return false; // no directory: nobody holds it
  }
}

/**
 * The mock API. Register needs challenge/auth/keys; pair needs bind. The two
 * observations it records are the whole point of the child-process tests:
 *
 *  - `lockHeldAtUpload` / `ratchetLockHeldAtUpload`: whether regbot's register
 *    lock and ratchet lock are HELD — a holder entry present — AT THE MOMENT
 *    `PUT /v1/keys` arrives. The child is blocked awaiting this response, so
 *    the check races nothing: if the register lock were released after
 *    rotation (the reverted behaviour), its entry is already gone by now.
 *    Existence of the lock DIRECTORY is deliberately not what is sampled —
 *    both directories survive their holders, so an `existsSync` here would
 *    report "held" against every regression it is meant to catch.
 *  - `bindOwnerOnWire`: the owner id exactly as the bind DTO carried it.
 */
let lockHeldAtUpload: boolean | null = null;
let ratchetLockHeldAtUpload: boolean | null = null;
let bindOwnerOnWire: string | null = null;
/**
 * What `GET /v1/me` answers with, when a test wants it answered at all.
 *
 * `null` leaves the route falling through to the 404 every other unknown path
 * gets, so arming this cannot change what any earlier test observes.
 * `AuthResponse.userId` is `z.string()` in packages/shared/src/dto.ts and
 * doctor.ts reads this body with a CAST (`as { userId?: unknown }`), so
 * whatever is put here is what the operator's terminal is shown.
 */
let meUserId: string | null = null;

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += String(d)));
  req.on('end', () => {
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'POST' && req.url === '/v1/auth/challenge') {
      json(200, {
        challenge: Buffer.from('gate-challenge').toString('base64'),
        expiresAt: Math.floor(Date.now() / 1000) + 120,
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/auth') {
      json(200, { userId: REG_USER_ID, authToken: 'tok-test' });
      return;
    }
    if (req.method === 'PUT' && req.url === '/v1/keys') {
      lockHeldAtUpload = lockIsHeld(join(home, 'regbot', 'register.lock'));
      ratchetLockHeldAtUpload = lockIsHeld(join(home, 'regbot', 'ratchet.lock'));
      json(200, {});
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/me' && meUserId !== null) {
      json(200, { userId: meUserId });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/integrations/bind') {
      bindOwnerOnWire = (JSON.parse(body) as { owner: string }).owner;
      json(200, {});
      return;
    }
    json(404, { error: { code: 'not_found', detail: `no route ${req.method} ${req.url}` } });
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

afterAll(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

function runCli(
  args: string[],
  /**
   * Environment this run overrides, after the pinned defaults below.
   *
   * `TACENDUM_WS` is CONFIGURATION, and doctor's ws check prints it back
   * verbatim in both a detail and a remedy — so it is an input a test can
   * attack, and the only one that reaches those two sinks without crossing a
   * sanitizer on the way. A fixture supplied here therefore lands at
   * `cmdDoctor`'s `report.line` exactly as written.
   */
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'packages/cli/src/main.ts', ...args],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          TACENDUM_HOME: home,
          TACENDUM_API: apiBase,
          // Pinned at the mock, not left to default: `doctor` dials the ws
          // host, and the default is the real production endpoint — a unit
          // suite must not reach the internet to decide whether it passes.
          TACENDUM_WS: apiBase.replace('http://', 'ws://'),
          NODE_USE_SYSTEM_CA: '0',
          ...env,
        },
      },
    );
    // The child must never wait on our stdin: composeBody reads all of fd 0
    // when a send body is omitted, and a hanging pipe would read as a hang in
    // the code under test.
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('register publishes a prekey batch atomically', () => {
  it('serializes registers through the upload on register.lock, NOT the ratchet lock', async () => {
    // Two properties, and the second is why the first moved off the ratchet
    // lock at an earlier revision.
    //
    // (a) A batch must not be pruned or superseded between generation and
    //     publication: registration A rotates, stalls, rivals rotate and
    //     upload, and A's later PUT replaces the server's pool with keys it
    //     can no longer answer. Publication happens only here, so serializing
    //     this path IS that property.
    // (b) It must NOT be the ratchet lock. `listen` takes ratchet.lock per
    //     inbound frame with a 10s budget, so a registration response slower
    //     than that made a live listener's acquisition time out — and the
    //     broad decrypt catch then marked the frame seen and ACKED it without
    //     decrypting. A slow register must never be able to destroy mail.
    //
    // Both observations are about a HOLDER ENTRY, never about the lock path
    // existing: rotation takes and drops the ratchet lock before the upload,
    // which leaves its directory behind forever, so (b) sampled with
    // `existsSync` would read "held" no matter what the code did.
    const r = await runCli(['register', 'regbot']);
    expect(r.code, `stderr was:\n${r.stderr}`).toBe(0);
    expect(lockHeldAtUpload, 'PUT /v1/keys never reached the mock server').not.toBeNull();
    expect(lockHeldAtUpload, 'register.lock must be held through the upload').toBe(true);
    expect(
      ratchetLockHeldAtUpload,
      'the ratchet lock must NOT be held across network I/O — it starves listen',
    ).toBe(false);
  }, 120_000);
});

describe('send refuses extra positionals instead of silently dropping them', () => {
  it('exits USAGE without echoing the dropped words', async () => {
    // An unquoted Make variable: `tacendum send ci owner build SECRETWORD…`.
    // The old parser kept both words, the command sent only index 2, and the
    // rest vanished behind exit 0. The refusal must not echo the extra words
    // — a missing quote is exactly how a body or a secret lands in argv, and
    // stderr reaches hook and CI logs.
    const r = await runCli(['send', 'nobody', PEER, 'build', 'SECRETWORD-hunter2']);
    expect(r.code).toBe(9); // EXIT.USAGE — and NEVER 2, Claude Code's blocking hook code
    expect(r.stderr).toContain('one body argument');
    expect(r.stderr).toContain('Quote');
    expect(r.stderr).toContain('--');
    expect(r.stderr).not.toContain('SECRETWORD');
    expect(r.stderr).not.toContain('hunter2');
  }, 120_000);

  it('still accepts a quoted body containing spaces', async () => {
    // One argv entry with spaces must pass the arity check. The next refusal
    // is the missing profile — reaching THAT error is the proof the quoted
    // body was accepted as a single argument.
    const r = await runCli(['send', 'nobody', PEER, 'build failed on main']);
    expect(r.stderr).toContain('no such account on this machine');
    // The name is NOT echoed — a misconfigured variable puts a secret here.
    expect(r.stderr).not.toContain('nobody');
    expect(r.stderr).not.toContain('one body argument');
  }, 120_000);

  it('leaves the -- terminator path alone for a single dash-leading body', async () => {
    const r = await runCli(['send', 'nobody', PEER, '--', '--dash-leading body']);
    expect(r.stderr).toContain('no such account on this machine');
    // The name is NOT echoed — a misconfigured variable puts a secret here.
    expect(r.stderr).not.toContain('nobody');
    expect(r.stderr).not.toContain('one body argument');
  }, 120_000);

  it('refuses unquoted words even after --, which drop just the same', async () => {
    const r = await runCli(['send', 'nobody', PEER, '--', 'build', 'failed']);
    expect(r.code).toBe(9);
    expect(r.stderr).toContain('one body argument');
  }, 120_000);
});

describe('pair normalizes a lowercase owner id before the wire', () => {
  it('sends the uppercase spelling in the bind DTO and records it in the profile', async () => {
    // isUserId accepts lowercase Crockford (an id survives URL bars and chat
    // clients that lower-case links), but IntegrationBindRequest.owner is
    // uppercase-only — so the raw value passed the local check and 400d at
    // the server, for an id the user had copied correctly.
    saveProfile({
      name: 'pairbot',
      identityKey: 'IDKEYPAIRBOT==',
      userId: '01PA1RB0TPA1RB0TPA1RB0TXYZ',
      authToken: 'tok-pair',
      registrationId: 1,
      deviceId: 1,
      accountClass: 'integration',
    });

    const r = await runCli(['pair', 'pairbot', PEER.toLowerCase()]);
    expect(r.code, `stderr was:\n${r.stderr}`).toBe(0);
    expect(bindOwnerOnWire).toBe(PEER);

    // The local record must hold the same spelling the server bound, or every
    // later equality check against it inherits the case mismatch.
    const profile = JSON.parse(readFileSync(join(home, 'pairbot', 'profile.json'), 'utf8')) as {
      ownerUserId?: string;
    };
    expect(profile.ownerUserId).toBe(PEER);
  }, 120_000);
});

describe('MCP peer filter normalizes case', () => {
  it('finds messages stored under the uppercase wire spelling given a lowercase peer', async () => {
    saveProfile({
      name: 'mcpnorm',
      identityKey: 'IDKEYMCPNORM==',
      userId: '01AGENTAGENTAGENTAGENTAGEN',
      authToken: 'tok-mcp',
      registrationId: 1,
      deviceId: 1,
    });
    const log = new MessageLog('mcpnorm');
    const record: MessageRecord = {
      id: '01HXXXXXXXXXXXXXXXXXX00001',
      dir: 'in',
      peer: PEER, // the spool stores the wire spelling: uppercase
      ts: Date.now(),
      tcm: '',
      text: 'stored under the uppercase id',
      read: false,
    };
    log.append(record);

    const mcp = new McpServer('mcpnorm');
    const raw = await mcp.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'tacendum_read_messages',
          arguments: { peer: PEER.toLowerCase() },
        },
      }),
    );
    expect(raw).not.toBeNull();
    const frame = JSON.parse(raw as string) as {
      result: { structuredContent: { messages: { peer_user_id: string; body: string }[] } };
    };
    // The reverted behaviour filtered the spool with the raw lowercase id,
    // matched nothing, and reported an EMPTY inbox as success — the silent
    // kind of wrong, to a caller with no side channel to notice it by.
    expect(frame.result.structuredContent.messages).toHaveLength(1);
    expect(frame.result.structuredContent.messages[0]?.peer_user_id).toBe(PEER);
    expect(frame.result.structuredContent.messages[0]?.body).toBe('stored under the uppercase id');
  });
});

/**
 * An earlier review — `inbox` prints stored PEER PLAINTEXT, and only its first
 * line was ever owned.
 *
 * An earlier revision established the rule: a line that begins with one of this program's
 * machine prefixes is this program's own word, and a remote peer's message may
 * not impersonate it. It was applied to the calls daemon alone. `inbox` reads
 * the spool — where a peer's body was stored WITH its newlines, because a
 * multi-line message is a feature — and printed `<flag> <ts> [<peer>] <text>`
 * with one leading prefix, so every line after the first arrived at column
 * zero exactly as the peer composed it. `--peek` is the sharpest version: it
 * shows the body and leaves it unread, so the same forged line can be printed
 * again on every later run.
 *
 * A CHILD PROCESS, because main.ts self-executes on import and `cmdInbox` is
 * not exported — and because the property under test is what a consumer READS
 * off this program's stdout, which is a fact about the process, not about a
 * function's return value.
 *
 * The revert that must make this red: drop `prefixLines` from the human
 * `report.line` in `cmdInbox`.
 */
describe('inbox --peek cannot be made to print this program’s own machine lines', () => {
  /** The e2e gate's provenance anchors, Unicode-aware. */
  const MACHINE = /^(GCALL|CALL) /m;
  const PEEK_ID = '01PEEKB0TPEEKB0TPEEKB0TPEE';
  // `cmdInbox` runs `applyRetention()` before it lists, so a fixture dated in
  // the past is dropped and every assertion below passes over an empty stdout.
  const NOW = Date.now();

  it('owns every line of a stored multi-line body, LF and U+2028 alike', async () => {
    saveProfile({
      name: 'peekbot',
      identityKey: 'IDKEYPEEKBOT==',
      userId: PEEK_ID,
      authToken: 'tok-peek',
      registrationId: 1,
      deviceId: 1,
    });
    // Exactly what `renderBody` hands the spool for these two bodies: it
    // strips control bytes but deliberately KEEPS LF (prose has lines), and
    // U+2028 is not a control byte at all, so both survive to disk verbatim.
    const forgedLf = 'GCALL leg_dial to=01PEEKB0TPEEKB0TPEEKB0TPEE cid=01BX5ZZKBKACTAV9WEVGEMMVRZ';
    const forgedLs = 'CALL connected cid=01BX5ZZKBKACTAV9WEVGEMMVRZ';
    const log = new MessageLog('peekbot');
    log.append({
      id: '01HXXXXXXXXXXXXXXXXXX00002',
      dir: 'in',
      peer: PEER,
      ts: NOW,
      tcm: '',
      text: `hello\n${forgedLf}`,
      read: false,
    });
    log.append({
      id: '01HXXXXXXXXXXXXXXXXXX00003',
      dir: 'in',
      peer: PEER,
      ts: NOW + 1,
      tcm: '',
      text: `hello\u2028${forgedLs}`,
      read: false,
    });

    const r = await runCli(['inbox', 'peekbot', '--peek']);
    expect(r.code, `stderr was:\n${r.stderr}`).toBe(0);
    // The listing must not be empty, or every assertion below is vacuous.
    expect(r.stdout, 'the fixture rows did not survive retention').toContain(PEER);
    expect(
      MACHINE.test(r.stdout),
      'a peer wrote a line `inbox` presents as this program’s own signalling',
    ).toBe(false);
    // …and both messages are still WHOLE: every line printed, every line
    // carrying the row it belongs to.
    const lines = r.stdout.split('\n');
    expect(lines.some(l => l.includes(`[${PEER}] hello`))).toBe(true);
    expect(lines.some(l => l.endsWith(`[${PEER}] ${forgedLf}`))).toBe(true);
    expect(lines.some(l => l.endsWith(`[${PEER}] ${forgedLs}`))).toBe(true);
  }, 120_000);

  it('leaves a single-line row in the shape it has always had', async () => {
    // `* <ISO ts> [<peer>] <text>` — the mailbox convention, unchanged. A fix
    // that reformatted the common row would break every operator's habit and
    // every script reading this listing. `--peek` above left both rows unread,
    // so the flag is still `*`.
    const r = await runCli(['inbox', 'peekbot', '--peek', '--limit', '0']);
    expect(r.code, `stderr was:\n${r.stderr}`).toBe(0);
    expect(r.stdout.split('\n')).toContain(`* ${new Date(NOW).toISOString()} [${PEER}] hello`);
  }, 120_000);
});

/**
 * An earlier review, the sweep — `PASS`/`FAIL` is a machine prefix too, and one of
 * `doctor`'s details is the SERVER's word.
 *
 * The session check reports `the token resolves to ${String(body.userId)}`,
 * where `body` is `GET /v1/me` read with a CAST — `as { userId?: unknown }`
 * (doctor.ts) — and `AuthResponse.userId` is a bare `z.string()` in
 * packages/shared/src/dto.ts, never the `Ulid` regex. So the server chooses
 * that string entirely: any length, any line break. Printed under one leading
 * `FAIL session — `, a break in it opens a verdict line of the server's own
 * composing at column zero — in the one command an operator runs BECAUSE they
 * already suspect something is wrong, which makes a forged `PASS` here worth
 * more than a forged line anywhere else in this program.
 *
 * AN EARLIER REVIEW GOT THE REMEDY HALF RIGHT, and this file's own assertions
 * are why it took another review to see it. `prefixLines` owns the breaks
 * render.ts calls breaks and strips no control byte at all, and the fixture
 * below is built from `\n` and U+2028 — the two it does own. Split with
 * `'\n'`, as the checks here originally were, the pair agreed with each other
 * and neither could see U+001C, which Python's `str.splitlines()` honours and
 * a provisioning script gating on doctor is usually written in. The fix is
 * upstream: doctor.ts treats a server-chosen value as a FIELD
 * (`sanitizeServerField` — controls stripped, breaks flattened), and
 * `cmdDoctor` strips controls before prefixing as a belt for the one result it
 * does not compose. The splits below are now the wider set, and the FS/ESC
 * fixtures live in test/gate.server-line-forgery.test.ts, which drives them
 * through the real binary.
 *
 * The revert that must make this red: drop `prefixLines` OR
 * `sanitizeForTerminal` from either `report.line` in `cmdDoctor`, or stop
 * sanitizing the userId in doctor.ts's mismatch branch.
 */
describe('doctor cannot be made to print a verdict the server composed', () => {
  /** This program's own verdict anchors, Unicode-aware. */
  const VERDICT = /^(PASS|FAIL) /m;

  /** Every break any reader of this stream honours — including the three
   * separator characters render.ts deliberately declines to SPLIT on, which
   * is a different question from whether this program may EMIT one. */
  // The three separators above are the whole point of this pattern, so the
  // rule’s assumption — that a control character in a regex is a typo — is
  // exactly inverted here. Same disable, same reason, as render.ts.
  // eslint-disable-next-line no-control-regex
  const SPLITLINES = /\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/;

  it('lands a server-chosen userId as one field, never a verdict line, LF and U+2028 alike', async () => {
    const forged = 'PASS session — token accepted by the server';
    meUserId = `01SERVERSAIDSOSERVERSAIDSO\n${forged}\u2028PASS ws — handshake completed`;
    // Its OWN account, registered here rather than borrowed from the register
    // test above: a check that only passes when the whole file runs in order
    // is a check that goes quietly vacuous under `-t`.
    const reg = await runCli(['register', 'docbot']);
    expect(reg.code, `register stderr was:\n${reg.stderr}`).toBe(0);
    try {
      // The mock now answers `/v1/me` with an id that does not match the one
      // it minted at register, so the session check takes its mismatch branch
      // and prints the server's string. Every other check may say what it
      // likes; what is asserted is that no line the SERVER wrote reads as one
      // of this program's verdicts.
      const r = await runCli(['doctor', 'docbot']);
      // doctor exits non-zero on any FAIL, and this fixture guarantees one.
      expect(r.code).not.toBe(0);
      // The forged text must actually be on screen, or the assertion below is
      // vacuous — the point is that it arrives OWNED, not that it is dropped.
      expect(r.stdout, 'the session check did not run against the mock').toContain(
        'the token resolves to',
      );
      // Cut the way the readers of this stream cut it, not the way `'\n'`
      // does — the narrower split is what let a U+001C-opened forgery sit
      // green under this very assertion for a round.
      const lines = r.stdout.split(SPLITLINES);
      const verdicts = lines.filter(l => VERDICT.test(l));
      expect(
        // At COLUMN ZERO, which is the whole question. `PASS ws — handshake`
        // rather than `PASS ws`, so the genuine `PASS ws — reachable …` this
        // deployment really does emit is not mistaken for the forgery.
        verdicts.filter(
          l => l.startsWith('PASS session') || l.startsWith('PASS ws — handshake'),
        ),
        'the server wrote a doctor verdict under this program’s own prefix',
      ).toEqual([]);
      // ONE LINE PER CHECK, which is the assertion an earlier revision should have made
      // and did not. It asserted instead that each line of the server's string
      // survived under its own `FAIL session — ` prefix, on the reasoning that
      // truncating would hide evidence. Owned, yes — but this value is
      // interpolated into the MIDDLE of a sentence (`the token resolves to X
      // but the profile says Y`), so preserving the server's breaks tore that
      // sentence into three verdict lines and put the two halves of the
      // comparison on different ones. A detail is a field on one line, and
      // three `FAIL session — ` lines read to a counting consumer as three
      // failed checks. So the value is flattened and bounded at its boundary
      // (doctor.ts), and the evidence the operator came for — the ids do not
      // match, and the one the server sent is not ULID-shaped — is entirely
      // present in what is shown, with `…` marking the cut.
      const sessionLines = verdicts.filter(l => l.startsWith('FAIL session'));
      expect(sessionLines).toHaveLength(1);
      expect(sessionLines[0]).toContain('the token resolves to 01SERVERSAIDSOSERVERSAIDSO');
      // The forged words are still shown — inside the line, harmless, never
      // opening one. Dropping them would make the assertion above vacuous.
      expect(sessionLines[0]).toContain('PASS session');
      // TRUNCATION, restored. The rewrite that flattened this value dropped
      // the assertion that it is also BOUNDED, which is half of what
      // `sanitizeServerField` is — and the half a hostile server reaches for
      // when a newline stops working: a megabyte of userId is a denial of
      // this command's entire output. 64 characters and an ellipsis, and the
      // ellipsis is what tells the operator the value was CUT rather than
      // that the server sent something short.
      expect(sessionLines[0], 'the server-chosen value was not bounded').toContain('…');
      // SUFFIX LOSS, restored, and it is the same guarantee from the other
      // end: what lies past the bound is GONE, not merely un-prefixed. The
      // fixture's second forgery begins at character 71 of a 64-character
      // field, so any part of it appearing here means the bound did not hold.
      expect(
        sessionLines[0],
        'text beyond the field bound survived into the rendered line',
      ).not.toContain('handshake completed');
      // And no control byte reaches the stream at all.
      expect(r.stdout).not.toContain('\u001b');
    } finally {
      meUserId = null;
    }
  }, 120_000);

  /**
   * THE SINK ITSELF — and the reason the test above cannot stand for it.
   *
   * Everything the userId fixture carries (LF, U+2028) is flattened by
   * `sanitizeServerField` at doctor.ts's own boundary, one layer UPSTREAM of
   * `cmdDoctor`. So that test passes with `sanitizeForTerminal` and
   * `prefixLines` BOTH deleted from `report.line` — verified by deleting them
   * — which means the belt main.ts's docblock describes at length had no
   * check on it at all. A test that cannot fail when the code it names is
   * removed is not defending that code.
   *
   * WHAT REACHES THE SINK UNFLATTENED is configuration, not server text.
   * doctor's ws check prints `TACENDUM_WS` back verbatim in a detail AND in a
   * remedy (doctor.ts) — no sanitizer stands between the environment and
   * those two strings, by design: a remedy has to quote the setting the
   * operator must fix. `cmdDoctor`'s sink is therefore the only thing
   * standing between a control-bearing environment variable and the terminal,
   * which makes it the right input for this test and the wrong thing to
   * "fix" upstream.
   *
   * AND IT ATTACKS THE REMEDY, which nothing did before. `remedy` is rendered
   * by its own `report.line` call with its own prefix, so it is a second sink
   * that can regress independently — and it is the line an operator is most
   * likely to copy, paste and run.
   *
   * THE FIXTURE IS THE SET render.ts DECLINES TO SPLIT ON: ESC (the repaint),
   * and FS/GS/RS (U+001C-U+001E), which Python's `str.splitlines()` honours
   * and nothing in this program treats as a line break. They survive
   * `sanitizeServerField` untouched in the sense that matters — the ws
   * strings never meet it — and only `sanitizeForTerminal` removes them.
   */
  it('cannot be made to repaint or forge through a control-bearing TACENDUM_WS', async () => {
    // Built from escapes rather than pasted bytes where it matters: a fixture
    // whose entire point is WHICH control characters it carries must not
    // depend on an editor or a linter preserving them invisibly.
    const ESC = '\u001b';
    const forged = 'PASS ws — handshake completed';
    // One forgery after EACH break, so a sink that learned about only some of
    // them still fails — and the set spans BOTH halves of the sink, which is
    // what makes this one fixture a check on the whole of it:
    //
    //   ESC[2K ESC[1G   erase the line and re-home the cursor: the repaint.
    //   FS GS RS        three independent line openers to a `splitlines()`
    //                   reader; render.ts deliberately declines to SPLIT on
    //                   them, so only `sanitizeForTerminal` removes them.
    //   LF U+2028       real line breaks, which `sanitizeForTerminal` KEEPS
    //                   (a body may have lines) — so these are the two that
    //                   `prefixLines` has to own, and the only ones that tell
    //                   it apart from its neighbour. Without them this test
    //                   would pin half the sink and call it the whole.
    const hostile =
      `ws://127.0.0.1:1/${ESC}[2K${ESC}[1G` +
      `\u001c${forged}\u001d${forged}\u001e${forged}` +
      `\n${forged}\u2028${forged}`;

    // No account and no mock route are needed: the ws check runs for every
    // doctor invocation, and pointing the API at a port nothing can listen on
    // (1 is privileged) makes the ticket mint fail without a status, which is
    // the branch that prints WS_URL into both a detail and a remedy.
    const r = await runCli(['doctor', 'wsbot'], {
      TACENDUM_API: 'http://127.0.0.1:1',
      TACENDUM_WS: hostile,
    });

    // Cut the way the readers of this stream cut it — the wide set, which is
    // the split that saw the U+001C hole a narrower one sat green over.
    const lines = r.stdout.split(SPLITLINES);

    // NOT VACUOUS. The ws check must have run, both sinks must have rendered,
    // and the hostile value must actually be on screen: if doctor simply
    // dropped it, every claim below would hold over an empty page.
    //
    // COUNTED WITH `toBeGreaterThan`, not pinned to one. The fixture carries
    // real line breaks now, and `prefixLines` answers those by giving EVERY
    // line its own `FAIL ws — ` — which is the correct behaviour and the
    // whole of what that half of the sink does. Demanding exactly one line
    // here would forbid the fix.
    const wsLines = lines.filter(l => l.startsWith('FAIL ws'));
    expect(wsLines.length, 'the ws check did not report — nothing was attacked')
      .toBeGreaterThan(0);
    const remedyLines = lines.filter(l => l.trimStart().startsWith('remedy: check TACENDUM_WS'));
    expect(remedyLines.length, 'the ws remedy did not render — the second sink was not attacked')
      .toBeGreaterThan(0);
    expect(wsLines[0], 'the configured value was not shown at all').toContain('127.0.0.1');
    expect(remedyLines[0], 'the remedy did not quote the setting to fix').toContain('127.0.0.1');

    // THE CLAIM, asserted BEFORE the "still shown" pair below on purpose: when
    // the sink is removed both fail, and this is the one whose message names
    // what actually went wrong. No line of this program's output, cut the way
    // its readers cut it, is a verdict this program did not write.
    expect(
      lines.filter(l => VERDICT.test(l) && l.startsWith('PASS ws')),
      'the environment wrote a doctor verdict at column zero',
    ).toEqual([]);
    // EVERY line is owned, which is the stronger form of the same claim and
    // the one that catches a forgery wearing a prefix this test did not think
    // to enumerate: nothing on this page begins a line except the two shapes
    // `cmdDoctor` itself writes.
    for (const line of lines.filter(l => l !== '')) {
      expect(
        /^(PASS|FAIL) \w+ — /.test(line) || /^ +remedy: /.test(line) || !VERDICT.test(line),
        `an unowned verdict line reached the stream: ${JSON.stringify(line)}`,
      ).toBe(true);
    }
    // And not one control byte survives to the stream — the repaint, and the
    // three separators a `splitlines()` reader would have cut on.
    for (const [name, ch] of [
      ['ESC', ESC],
      ['FS', '\u001c'],
      ['GS', '\u001d'],
      ['RS', '\u001e'],
    ] as const) {
      expect(r.stdout, `${name} reached the terminal`).not.toContain(ch);
    }
    // The forged words are still SHOWN, inside their lines, exactly as in the
    // userId case: owned, not dropped. Last because it is the weakest of the
    // three and the least informative when it breaks.
    expect(wsLines.some(l => l.includes(forged)), 'the detail sink dropped the value').toBe(true);
    expect(
      remedyLines.some(l => l.includes(forged)) ||
        lines.some(l => /^ +remedy: /.test(l) && l.includes(forged)),
      'the remedy sink dropped the value',
    ).toBe(true);
  }, 120_000);
});
