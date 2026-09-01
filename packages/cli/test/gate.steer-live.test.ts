import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * THE LIVE STEER GATE — `turn/steer` against
 * the INSTALLED codex binary, re-proving the measured facts on
 * every version bump, in gate.codex-appserver.test.ts's pattern (real
 * binary, real driver and client, isolated signed-in CODEX_HOME):
 *
 *   1. a steer fired into a running turn answers `{turnId}` and the FINAL
 *      answer is the steered text — through the shipped driver+client path;
 *   2. a wrong `expectedTurnId` steer errors while the turn completes
 *      UNHARMED — proven at the wire, probe-shaped, because the shipped
 *      client cannot be told to send a wrong id (that is the point of it).
 *
 * SKIPS LOUDLY where the binary or the sign-in is absent: unlike the
 * approval gate (whose skip would hide silent version skew on the machine
 * that ships), steering's version canary is already carried by that
 * non-skippable gate — so this one states its absence in the run output
 * instead of failing contributors who cannot sign in.
 *
 * AUTH: the operator's real `~/.codex/auth.json` is COPIED into the gate's
 * isolated home (read-only of the real home), DELETED in afterAll, and
 * never read, printed, or asserted on beyond existence.
 */

const REAL_HOME = userInfo().homedir;

function resolveCodex(): string | undefined {
  const fromEnv = process.env.CODEX_BIN;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    const hit = execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8' }).trim();
    if (hit !== '') return hit;
  } catch {
    /* fall through to the nvm sweep */
  }
  const nvm = join(REAL_HOME, 'Library', 'Application Support', 'Herd', 'config', 'nvm', 'versions', 'node');
  try {
    for (const v of readdirSync(nvm)) {
      const p = join(nvm, v, 'bin', 'codex');
      if (existsSync(p)) return p;
    }
  } catch {
    /* no nvm tree either */
  }
  return undefined;
}

const CODEX = resolveCodex();
const SIGNED_IN = existsSync(join(REAL_HOME, '.codex', 'auth.json'));
const LIVE = CODEX !== undefined && SIGNED_IN;
const WHY_NOT =
  CODEX === undefined
    ? 'codex binary not found (PATH, Herd nvm, CODEX_BIN)'
    : 'codex is not signed in (~/.codex/auth.json missing)';

const home = mkdtempSync(join(tmpdir(), 'tacendum-steer-live-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://steer-live.test';
process.env.TACENDUM_WS = 'ws://steer-live.test';

const { realSession } = await import('../src/attend.js');
const { driverFor } = await import('../src/attend-drivers.js');
const { CODEX_APPSERVER_VERSION } = await import('../src/codex-appserver.js');
import type { AttendConfig } from '../src/attend.js';
import type { DriverIo, SessionHandle, SteerableTurn } from '../src/attend-drivers.js';

const CODEX_HOME = join(home, 'state', 'gate', 'codex-home');
const WORKDIR = join(home, 'gate-workdir');

afterAll(() => {
  // The copied OAuth token must not outlive the gate.
  rmSync(home, { recursive: true, force: true });
});

function signedInHome(): void {
  mkdirSync(CODEX_HOME, { recursive: true, mode: 0o700 });
  mkdirSync(WORKDIR, { recursive: true });
  const copy = join(CODEX_HOME, 'auth.json');
  copyFileSync(join(REAL_HOME, '.codex', 'auth.json'), copy);
  chmodSync(copy, 0o600);
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

if (!LIVE) {
  describe('gate: turn/steer against the installed binary — SKIPPED', () => {
    it(`SKIPPED LOUDLY: ${WHY_NOT} — the steer facts are UNPROVEN on this machine`, ctx => {
      console.warn(
        `[gate.steer-live] SKIPPED: ${WHY_NOT}. ` +
          'The measured turn/steer behaviour (delivery, mismatch-unharmed) was not re-proven here.',
      );
      ctx.skip();
    });
  });
} else {
  const BIN = CODEX as string;

  const cfg: AttendConfig = {
    host: 'codex',
    bin: BIN,
    workdir: WORKDIR,
    // read-only: a counting turn needs no approval, so nothing can park and
    // race the steer with an ask.
    caps: ['-s', 'read-only'],
    codexDriver: 'app-server',
    ownSession: '7d9f7c3a-1b2e-4c5d-8e9f-0a1b2c3d4e5f',
    turnsPerHour: 10,
  };

  const io: DriverIo = {
    spawn: async () => {
      throw new Error('the app-server driver must never use the spawn seam');
    },
    session: (argv, cwd, env) => realSession(BIN, argv, cwd, env),
  };

  describe('gate: turn/steer against the installed binary', () => {
    it('the installed binary is the version the steer facts were measured on', () => {
      const version = execFileSync(BIN, ['--version'], { encoding: 'utf8' }).trim();
      expect(
        version,
        `installed codex (${version}) != measured version (${CODEX_APPSERVER_VERSION}). ` +
          'Re-probe turn/steer (delivery result shape, -32600 arms, partial-completes-then-' +
          'steered-answer ordering) before trusting this gate green.',
      ).toContain(CODEX_APPSERVER_VERSION);
    });

    it(
      'a steer into a running turn is DELIVERED and the final answer is the steered text',
      async () => {
        signedInHome();
        let surfaced: SteerableTurn | undefined;
        const run = driverFor('codex').runTurn(
          {
            cfg,
            route: { kind: 'own' },
            prompt: 'Count from 1 to 120, one number per line, no other text.',
            account: 'gate',
            steering: t => {
              surfaced = t;
            },
          },
          io,
        );
        const until = Date.now() + 120_000;
        while (surfaced === undefined) {
          if (Date.now() > until) throw new Error('the steer surface never appeared');
          await sleep(50);
        }
        // Into the generation window (the probe's first delta landed ~4.4s
        // after turn/start on this machine class; 120 lines stream for
        // several seconds beyond it).
        await sleep(5_000);
        const got = await (surfaced as SteerableTurn).steer(
          'Stop counting immediately. Reply with exactly: steered-p43-live',
        );
        expect(got, 'the running turn must accept the steer').toBe('delivered');

        const res = await run;
        expect(res.code).toBe(0);
        // The reply is the LAST completed agentMessage — the steered answer,
        // not the interrupted count.
        expect(res.stdout).toContain('steered-p43-live');
        expect(res.stdout, 'the partial count is dropped from the reply').not.toContain('\n30\n');
      },
      300_000,
    );

    it(
      'a wrong-expectedTurnId steer errors while the turn completes UNHARMED — the mismatch is a refusal, not a poison',
      async () => {
        signedInHome();
        // Probe-shaped raw frames over the real duplex seam: the shipped
        // client cannot be told to send a wrong id, so the wire is driven
        // directly here — the same frames the capture preserved.
        // Nothing from any error frame is logged or asserted on beyond its
        // presence and code (the message embeds raw turn ids).
        const outcome = await new Promise<{
          steerErrorCode: number | undefined;
          turnStatus: string | undefined;
          finalText: string;
        }>((resolve, reject) => {
          const session: SessionHandle = realSession(
            BIN,
            ['app-server', '--strict-config'],
            WORKDIR,
            { CODEX_HOME },
          );
          const timer = setTimeout(() => {
            session.kill();
            reject(new Error('live mismatch leg timed out'));
          }, 240_000);
          const send = (frame: Record<string, unknown>): void =>
            session.write(JSON.stringify(frame));
          let threadId = '';
          let steerId = 0;
          let steerErrorCode: number | undefined;
          let steered = false;
          let finalText = '';
          session.onExit(() => {
            /* resolution happens at turn/completed below */
          });
          session.onLine(line => {
            let f: Record<string, unknown>;
            try {
              f = JSON.parse(line) as Record<string, unknown>;
            } catch {
              return;
            }
            const id = f.id;
            const method = f.method;
            if (id !== undefined && method === undefined) {
              const result = (f.result ?? {}) as Record<string, unknown>;
              if (id === 1) {
                send({ method: 'initialized' });
                send({
                  id: 2,
                  method: 'thread/start',
                  params: { cwd: WORKDIR, approvalPolicy: 'untrusted', sandbox: 'read-only' },
                });
              } else if (id === 2) {
                threadId = ((result.thread ?? {}) as Record<string, unknown>).id as string;
                send({
                  id: 3,
                  method: 'turn/start',
                  params: {
                    threadId,
                    input: [
                      { type: 'text', text: 'Count from 1 to 40, one number per line, no other text.' },
                    ],
                  },
                });
              } else if (id === steerId && 'error' in f) {
                const err = (f.error ?? {}) as Record<string, unknown>;
                steerErrorCode = typeof err.code === 'number' ? err.code : undefined;
              }
              return;
            }
            if (method === 'item/agentMessage/delta' && !steered && threadId !== '') {
              // The exact moment: AFTER the first delta, a steer
              // whose expectedTurnId is wrong on purpose.
              steered = true;
              steerId = 4;
              send({
                id: steerId,
                method: 'turn/steer',
                params: {
                  threadId,
                  expectedTurnId: '019ff79b-ffff-7fff-bfff-ffffffffffff',
                  input: [{ type: 'text', text: 'probe: wrong expectedTurnId' }],
                },
              });
              return;
            }
            if (method === 'item/completed') {
              const item = ((f.params ?? {}) as Record<string, unknown>).item as
                | Record<string, unknown>
                | undefined;
              if (item?.type === 'agentMessage' && typeof item.text === 'string') {
                finalText = item.text;
              }
              return;
            }
            if (method === 'turn/completed') {
              const turn = ((f.params ?? {}) as Record<string, unknown>).turn as
                | Record<string, unknown>
                | undefined;
              clearTimeout(timer);
              session.kill();
              resolve({
                steerErrorCode,
                turnStatus: typeof turn?.status === 'string' ? turn.status : undefined,
                finalText,
              });
            }
          });
          send({
            id: 1,
            method: 'initialize',
            params: {
              clientInfo: { name: 'tacendum-steer-gate', title: 'steer gate', version: '1' },
              capabilities: { experimentalApi: false, requestAttestation: false },
            },
          });
        });

        // The measured refusal: -32600, and NOTHING delivered — the turn
        // runs to completion with the full un-steered answer.
        expect(outcome.steerErrorCode).toBe(-32600);
        expect(outcome.turnStatus).toBe('completed');
        expect(outcome.finalText, 'the count ran to its end unharmed').toContain('40');
        expect(outcome.finalText).not.toContain('wrong expectedTurnId');
      },
      300_000,
    );
  });
}
