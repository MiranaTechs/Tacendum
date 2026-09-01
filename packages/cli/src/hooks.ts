import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { monotonicFactory } from 'ulid';
import { markAgentBody, markerAttested } from './ai-origin.js';
import { flagString, parseArgs, type ParsedArgs } from './args.js';
import { stateDir } from './config.js';
import { CliError, EXIT, type ExitCode } from './exit.js';
import { isIdentityChange } from './messaging.js';
import { MessageLog } from './msglog.js';
import type { Reporter } from './output.js';
import { loadProfile, resolveRecipient } from './profile.js';
import { sanitizeForTerminal, sanitizeServerField } from './render.js';
import { sendEncrypted } from './send.js';
import { AuthSession } from './session.js';
import { FileStores, writeFileAtomic } from './stores.js';

/**
 * `tacendum notify --hook <host>` — the ONE code path
 * every agent surface funnels into.
 *
 * The research doc is explicit: "All surfaces funnel into one command", and
 * the reason is this repo's most-repeated defect class — a rule implemented at
 * two call sites that then diverge. So the split here is strict:
 *
 *   - ONE host-agnostic core (`runNotify`) that takes a normalized
 *     `HookEvent { kind, body, projectTag }`, composes the plaintext, sends
 *     it, and owns the queue-on-failure and deadline rules.
 *   - Per-host PARSERS that differ ONLY in where the payload comes from and
 *     what its fields are called. A parser produces a `ParsedHook` and decides
 *     nothing about sending.
 *
 * THE LOAD-BEARING NON-FUNCTIONAL REQUIREMENT: this command must never block
 * the agent that invoked it. Verified against each host's current docs
 * (2026-07-30): Claude Code, Cursor AND Gemini CLI all treat hook exit code 2
 * as "block the action", so EXIT codes here come from exit.ts, where 2 is
 * permanently absent. Beyond the code itself:
 *
 *   - an internal deadline (~5 s) bounds the whole network attempt, and the
 *     stdin read — which happens BEFORE that deadline exists — carries its own
 *     bound (`readHookStdin`): a host that opens the pipe and never closes it
 *     must not hang the hook either. The one budget the deadline cannot
 *     preempt is a contended ratchet lock: acquisition blocks the event loop
 *     synchronously (lock.ts), bounded only by the lock's own 10 s wait;
 *   - on ANY send failure — network down, auth dead, safety refusal,
 *     deadline — the notification is QUEUED to disk and the command exits 0;
 *   - `cmdNotify` (the wired entry point) hard-exits the process, because a
 *     TCP dial to an unreachable host outlives any promise race and a hook
 *     that "returned" but keeps the event loop alive is still a hung hook.
 *
 * Setup mistakes (unknown --hook value, unregistered account, unpaired
 * integration with no --to) THROW EXIT.USAGE instead: they surface the first
 * time the operator tests the wiring, and on every verified host a non-2
 * non-zero exit is fail-open — Claude Code proceeds on exit 1, Cursor and
 * Gemini treat other codes as a warning, Codex ignores the exit entirely.
 *
 * Host payload shapes (each verified 2026-07-30; source noted inline):
 *   claude  stdin JSON  — code.claude.com/docs/en/hooks
 *   codex   FINAL ARGV argument, kebab-case JSON — openai/codex
 *           codex-rs/hooks/src/legacy_notify.rs ("appended as the final argv
 *           argument"; stdin is /dev/null)
 *   cursor  stdin JSON, two-hook dance — cursor.com/docs/agent/hooks
 *   gemini  stdin JSON — google-gemini/gemini-cli docs/hooks/reference.md
 */

const ulid = monotonicFactory();

/** The four hosts the one command serves. */
export const HOOK_HOSTS = ['claude', 'codex', 'gemini', 'cursor'] as const;
export type HookHost = (typeof HOOK_HOSTS)[number];

/**
 * BYTE ceiling for a hook notification BODY — 2 KB of truncation output.
 *
 * Since the crew-chat cap landed, hook bodies are clipped FIRST by
 * `capChatHead` (280 chars, HEAD kept — prose starts with its outcome), and
 * a capped body can never reach this bound (280 UTF-16 units are under 2 KB
 * in every encoding of them). This byte rule remains behind it as the
 * defence in depth and the owner of the omission-marker contract for any
 * direct caller of `boundBodyTail`.
 *
 * The bound is on `boundBodyTail`'s result: omission marker INCLUDED, its
 * output never exceeds this, which is what makes the function idempotent
 * (already-bounded text re-enters the early-return path unchanged). It is NOT
 * a bound on the whole message: `composeHookBody` puts a title line (itself
 * bounded at 200 chars) plus a newline ON TOP of this.
 *
 * Deliberately far below `send`'s 16 KB: the design caps integration
 * plaintext at ~1–2 KB "to blunt exfil bandwidth" — and the chat cap
 * tightens that channel further still.
 */
export const NOTIFY_MAX_BODY_BYTES = 2 * 1024;

/**
 * The whole network attempt — queue flush plus the live event — fits inside
 * this, or the event is queued and the process exits 0. ~5 s, because
 * hosts run Stop hooks synchronously by default, so every millisecond
 * here is a millisecond the operator waits after every agent turn.
 */
const NOTIFY_DEADLINE_MS = 5_000;

/** Don't START another queued-entry send with less than this budget left. */
const FLUSH_FLOOR_MS = 500;

/** Queued notifications older than this are dropped — it matches the server
 * queue's own 30-day TTL; nobody wants a month-old "build finished". */
const QUEUE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** At most this many UNCLAIMED queued entries per account; oldest dropped
 * first. An offline machine's hook must not grow an unbounded plaintext spool.
 * Entries claimed by an in-flight flush sit on top of this until they are
 * delivered or restored, so the directory can briefly hold the cap plus one
 * claim per live flusher. */
const QUEUE_MAX_ENTRIES = 100;

/** A `.claim.<pid>` older than this belongs to a crashed flush; restored. */
const CLAIM_STALE_MS = 10 * 60 * 1000;

/** Cursor cache entries older than this are swept — the bound that keeps a
 * crashed run from stranding agent plaintext on disk forever. */
const CURSOR_CACHE_STALE_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// The normalized event — what every parser produces and the core consumes.
// ---------------------------------------------------------------------------

export interface HookEvent {
  /** 'finished' (the agent stopped) or 'attention' (it needs a human). */
  kind: 'finished' | 'attention';
  /** What the agent last said. May be '' — the finish itself is the news. */
  body: string;
  /** Short label for WHICH project fired, from the host's cwd. */
  projectTag?: string | undefined;
  /** The HOST's own session key, where one exists:
   * claude/gemini `session_id`, cursor `conversation_id`, codex `thread-id`.
   * Host-supplied, so it is handled as sensitive —
   * recorded in the local ledger,
   * NEVER echoed to stderr, --json, or a title — and it is SHAPE-CHECKED
   * before it gets here (`hostSessionKey`): absent means either the host sent
   * none or the one it sent could not be a session key. */
  session?: string | undefined;
}

/** What a parser decided. Only cursor produces anything but 'send'/'ignore'. */
export type ParsedHook =
  | { action: 'send'; event: HookEvent }
  | { action: 'cache'; conversationId: string; text: string }
  | { action: 'send-cached'; conversationId: string; event: HookEvent }
  | { action: 'ignore'; reason: string };

/**
 * A payload that did not have the host's documented shape.
 *
 * NEVER carries any of the payload's content: the payload is agent output —
 * i.e. potentially anything a repo or a prompt injected — and this message
 * reaches stderr, which every host writes into its own logs.
 */
class HookPayloadError extends Error {}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseJsonPayload(raw: string, host: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HookPayloadError(`the ${host} hook payload is not valid JSON`);
  }
  const record = asRecord(parsed);
  if (!record) {
    throw new HookPayloadError(`the ${host} hook payload is not a JSON object`);
  }
  return record;
}

/** `/Users/x/proj` -> `proj`. Sanitized: a cwd is host-supplied text and the
 * tag ends up inside a title that also renders on the operator's terminal. */
function projectTagFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const tag = sanitizeForTerminal(basename(path)).slice(0, 40);
  return tag || undefined;
}

/**
 * THE SHAPE OF A HOST SESSION KEY — the one gate between an agent host's
 * payload and an argv slot.
 *
 * A session id is OPAQUE to us: we never read meaning out of it, we only hand
 * it back to the host that minted it. But opaque is not "arbitrary bytes", and
 * the difference is the whole security argument — this value is the ONE
 * agent-supplied string that reaches an agent command line (attend.ts
 * `turnArgv` records why it has to), and both hosts' parsers read a
 * dash-leading value as an OPTION. Verified on this machine, 2026-08-01, with
 * a bogus flag so nothing could take effect:
 *
 *   $ codex exec -s read-only resume "--zzz-not-a-real-flag" --help
 *   error: unexpected argument '--zzz-not-a-real-flag' found
 *   $ claude -p --resume --zzz-not-a-real-flag
 *   error: unknown option '--zzz-not-a-real-flag'
 *
 * That is the argv injection an earlier fix closed for the PROMPT, arriving through
 * the session key instead — and the payload it arrives in is the agent host's,
 * i.e. the prompt-injectable surface this whole feature exists to serve. A NUL
 * is the same class one layer down: it makes `spawn` itself throw.
 *
 * The class is a deliberate SUPERSET of what the four hosts emit, and it stops
 * exactly where a byte would start meaning something to a parser, a shell or a
 * path. What the hosts actually emit:
 *
 *   claude  UUID. `session_id` NAMES the transcript file — this machine's
 *           ~/.claude/projects/<proj>/00fa0485-9029-4584-a105-006517edb27a.jsonl
 *           carries "sessionId":"00fa0485-…" as its first record — and claude
 *           2.1.187 refuses anything else itself: `--session-id=<junk>` answers
 *           "Invalid session ID. Must be a valid UUID."
 *   codex   UUIDv7. The notify payload's `thread-id` — the id `exec resume`
 *           takes — is one: the committed capture
 *           (a captured transcript) carries
 *           019ff79c-6737-7ab2-b66b-1e4ca184c56d, and it passes this class
 *           unchanged. This bullet used to say the payload carries NO session
 *           id — read from the docs; the binary, measured (2026-08-12, spike
 *           0.2.1), disagrees.
 *   gemini  `session_id`, documented as the base field alongside `cwd`
 *           (docs/hooks/reference.md) and believed to be a UUID like the
 *           others — but gemini-cli is not installed here, so that is READ,
 *           not sampled, and it is stated as the uncertainty it is.
 *   cursor  `conversation_id`, documented only as the "stable ID of the
 *           conversation" — no shape given at all, and cursor is not installed
 *           here either.
 *
 * The last two are exactly why the class stays WIDER than UUID: guessing
 * narrower than a host we could not sample would silently drop every route
 * from it, and a routing feature that quietly does nothing is worse than one
 * that says it cannot.
 *
 * Hence: alphanumerics, dot, underscore, hyphen — with the FIRST character
 * alphanumeric, which is the structural bar on a leading `-` — bounded at
 * SESSION_KEY_MAX. Refused: NUL and every other control character, whitespace,
 * quotes, `/`, `\`, `$`, `;`, backtick, and everything non-ASCII.
 *
 * REJECTION IS NOT AN ERROR, and that is load-bearing. It means "this ledger
 * row gets no session key": the notification still composes, still sends, and
 * still arrives; only ROUTING degrades — to exactly the honest answer codex's
 * absent id already produces ("that session ended… send a bare text"). A hook
 * that refused to deliver over a malformed metadata field would be a notifier
 * that stopped notifying, which is the failure mode this whole module is
 * written against.
 *
 * It also REPLACES a truncation, and that is an improvement, not a relaxation:
 * `slice(0, 128)` turned an over-long key into a SHORTER key, which names a
 * different transcript or none — a wrong answer wearing a bounded answer's
 * clothes. The bound is now part of the shape, and a key that does not fit is
 * not a key.
 */
export const SESSION_KEY_MAX = 128;

/** Length is checked separately, so this stays a simple linear match. */
const SESSION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function hostSessionKey(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length === 0 || raw.length > SESSION_KEY_MAX) return undefined;
  return SESSION_KEY_RE.test(raw) ? raw : undefined;
}

// ---------------------------------------------------------------------------
// Per-host parsers. Each differs ONLY in payload source and field names.
// ---------------------------------------------------------------------------

/**
 * Claude Code (code.claude.com/docs/en/hooks): stdin JSON. `Stop` carries the
 * final text as `last_assistant_message`; `Notification` carries `message`
 * (matchers `permission_prompt|idle_prompt|agent_needs_input`). Both carry
 * `cwd`. Any other event wired here by mistake is ignored, not sent: a
 * PreToolUse firing dozens of times per turn must not become dozens of pings.
 */
export function parseClaudeHook(stdinText: string): ParsedHook {
  const payload = parseJsonPayload(stdinText, 'claude');
  const eventName = str(payload.hook_event_name);
  const projectTag = projectTagFromPath(str(payload.cwd));
  const session = hostSessionKey(str(payload.session_id));
  if (eventName === 'Stop') {
    return {
      action: 'send',
      event: { kind: 'finished', body: str(payload.last_assistant_message) ?? '', projectTag, session },
    };
  }
  if (eventName === 'Notification') {
    return {
      action: 'send',
      event: { kind: 'attention', body: str(payload.message) ?? '', projectTag, session },
    };
  }
  // The event NAME is not echoed: it is host/payload-supplied text
  // headed for stderr and the --json `reason` field, and a hostile payload can
  // put anything there. Which events notify on is documented above; a name is
  // not needed to say "not one of them".
  return { action: 'ignore', reason: 'the claude event is not one notify sends for' };
}

/**
 * Codex CLI: the payload is the FINAL ARGV ARGUMENT, not stdin — codex spawns
 * the notify program with stdin on /dev/null and appends one JSON string
 * (openai/codex codex-rs/hooks/src/legacy_notify.rs, verified 2026-07-30).
 * Keys are kebab-case; the only event is `agent-turn-complete`, and it
 * carries the session as `thread-id` (the session line below cites
 * the measurement).
 */
export function parseCodexHook(argvPayload: string | undefined): ParsedHook {
  if (argvPayload === undefined) {
    throw new HookPayloadError(
      'codex passes the payload as the final argument and none was given — ' +
        'config.toml wants: notify = ["tacendum", "notify", "--hook", "codex", "--account", "<name>"]',
    );
  }
  const payload = parseJsonPayload(argvPayload, 'codex');
  const type = str(payload.type);
  if (type !== 'agent-turn-complete') {
    // The type is not echoed — payload-supplied, see the claude parser.
    return { action: 'ignore', reason: 'the codex event is not one notify sends for' };
  }
  return {
    action: 'send',
    event: {
      kind: 'finished',
      body: str(payload['last-assistant-message']) ?? '',
      projectTag: projectTagFromPath(str(payload.cwd)),
      // `thread-id` IS the session key: it is the id `exec resume` takes.
      // Measured 2026-08-12: a captured payload
      // carries it byte-identical to
      // the exec capture's `thread.started.thread_id`, and the resume
      // capture shows `exec resume` loading real history
      // on that value. Same gate as every other host: the ledger gets it
      // only SHAPED like a key (`hostSessionKey`), and from there it
      // reaches the phone only as `sessionTag`, never raw.
      session: hostSessionKey(str(payload['thread-id'])),
    },
  };
}

/**
 * Gemini CLI (google-gemini/gemini-cli docs/hooks/reference.md, verified
 * 2026-07-30): stdin JSON with the same base fields as Claude's. `AfterAgent`
 * carries the final text as `prompt_response`; `Notification` carries
 * `message`.
 */
export function parseGeminiHook(stdinText: string): ParsedHook {
  const payload = parseJsonPayload(stdinText, 'gemini');
  const eventName = str(payload.hook_event_name);
  const projectTag = projectTagFromPath(str(payload.cwd));
  const session = hostSessionKey(str(payload.session_id));
  if (eventName === 'AfterAgent') {
    return {
      action: 'send',
      event: { kind: 'finished', body: str(payload.prompt_response) ?? '', projectTag, session },
    };
  }
  if (eventName === 'Notification') {
    return {
      action: 'send',
      event: { kind: 'attention', body: str(payload.message) ?? '', projectTag, session },
    };
  }
  // The event name is not echoed — payload-supplied, see the claude parser.
  return { action: 'ignore', reason: 'the gemini event is not one notify sends for' };
}

/**
 * Cursor (cursor.com/docs/agent/hooks, verified 2026-07-30): the two-hook
 * dance. `afterAgentResponse` carries the text (field `text`) but fires per
 * response, not at the end; `stop` is the finish event and carries NO text.
 * So: cache the text on `afterAgentResponse`, send the cached text on `stop`.
 * The cache is keyed by `conversation_id` ("stable ID of the conversation
 * across many turns") so two concurrent Cursor sessions cannot read each
 * other's text. There is no `cwd` in the base payload; the first of
 * `workspace_roots` stands in for it.
 */
export function parseCursorHook(stdinText: string): ParsedHook {
  const payload = parseJsonPayload(stdinText, 'cursor');
  const eventName = str(payload.hook_event_name);
  const conversationId = str(payload.conversation_id) ?? '';
  if (eventName === 'afterAgentResponse') {
    return { action: 'cache', conversationId, text: str(payload.text) ?? '' };
  }
  if (eventName === 'stop') {
    const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
    return {
      action: 'send-cached',
      conversationId,
      event: {
        kind: 'finished',
        body: '', // filled from the cache by the core
        projectTag: projectTagFromPath(str(roots[0])),
        // The cache key was always the session key; now the ledger gets it —
        // but only if it is SHAPED like one (`hostSessionKey`), because from
        // here it can reach an agent's argv. The CACHE key above needs no such
        // rule and deliberately does not get one: it is the SHA-256 of the id,
        // so any bytes at all map to a safe filename, and refusing an odd
        // conversation id there would drop the operator's response text to buy
        // nothing. Odd id, then: the notification still sends, the text still
        // rides with it, and only the reply ROUTE degrades to the honest
        // ended-session answer.
        session: hostSessionKey(conversationId),
      },
    };
  }
  // The event name is not echoed — payload-supplied, see the claude parser.
  return { action: 'ignore', reason: 'the cursor event is not one notify sends for' };
}

// ---------------------------------------------------------------------------
// Body composition — ONE bound, applied at ONE place: composeHookBody.
// ---------------------------------------------------------------------------

/**
 * THE truncation rule for agent text: TOTAL output — omission marker
 * included — at most NOTIFY_MAX_BODY_BYTES, tail kept, a marker for what was
 * dropped. Applied at exactly ONE place, `composeHookBody`, the funnel every
 * body passes through for every host; a second call site (the cursor cache
 * write once had one) is the two-call-site divergence this repo keeps
 * finding.
 *
 * Idempotent by construction, so even a future second caller cannot corrupt
 * the marker: the output fits the cap and never ends in a newline, so a
 * re-application takes the early return unchanged. Two ingredients make that
 * hold:
 *   - the marker's room is RESERVED inside the cap (sized for the worst-case
 *     dropped count, so the real, never-larger count always fits);
 *   - the cut seam skips UTF-8 continuation bytes instead of decoding and
 *     stripping U+FFFD — no artifact is produced, and text that LEGITIMATELY
 *     contains '�' passes through undamaged (an all-'�' tail once stripped
 *     to nothing, leaving a trailing newline the next pass then removed).
 */
/**
 * THE cut seam: the last `maxBytes` bytes of `text`, moved forward to the next
 * codepoint boundary. A cut mid-codepoint would decode to U+FFFD; stepping
 * past continuation bytes (0b10xxxxxx) produces no artifact and leaves text
 * that LEGITIMATELY contains '�' undamaged. One implementation, shared by the
 * marker bound below and the cursor cache cap — a second seam was starting to
 * grow, and two seams is this repo's two-call-site divergence.
 */
function tailWithinBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

/** The head-keeping twin, for the cursor cache: the FIRST `maxBytes` bytes,
 * moved BACK off a continuation byte so the cut is a codepoint boundary. */
function headWithinBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

export function boundBodyTail(text: string): string {
  const stripped = text.replace(/\n+$/, '');
  const total = Buffer.byteLength(stripped, 'utf8');
  if (total <= NOTIFY_MAX_BODY_BYTES) return stripped;
  const markerFor = (dropped: number): string => `[…${dropped} earlier byte(s) omitted]\n`;
  // Worst-case reservation: the true dropped count is < total, so its
  // marker has at most this many bytes and marker + tail always fits the cap.
  const room = NOTIFY_MAX_BODY_BYTES - Buffer.byteLength(markerFor(total), 'utf8');
  const kept = tailWithinBytes(stripped, room);
  return `${markerFor(total - Buffer.byteLength(kept, 'utf8'))}${kept}`;
}

/**
 * Compose the plaintext a notification carries: one title line, then the
 * (bounded) body. Same protocol posture as `send --title` — a newline-joined
 * two-line text, NOT a new envelope kind, so every phone build that exists
 * renders it (a `notify` envelope would say "Unsupported message" until an
 * app release shipped alongside).
 *
 * The title is host/agent-supplied material headed for a terminal and a lock
 * screen, so it is sanitized and bounded exactly as `send` bounds its
 * `--title` (200 chars).
 */
/**
 * THE CHAT CAP (crew-chat spec, Task A). A hook body is an agent's last
 * message, and an agent that ignores the crew-chat voice hands us a REPORT —
 * paragraphs of it. The phone is a chat, so the cap keeps a chat bubble's
 * worth and no more.
 *
 * HEAD-keeping, which is deliberately the opposite of `boundBodyTail`: build
 * output (run's tail) ends with its conclusion, but prose STARTS with it —
 * an agent's closing words are "let me know if…", its opening words are the
 * outcome. Cut at the last sentence boundary that fits; when a body has no
 * boundary at all, hard-cut without splitting a surrogate pair. The ellipsis
 * is the whole story the room needs: "details on request" is the voice's own
 * rule, and the full text was never lost — it is on the machine that sent it.
 *
 * Characters, not bytes, because the budget is a READING budget; the byte
 * bound below still runs after (280 chars is at most ~1.1KB, so it no-ops).
 * Applied only here, in the one funnel — the same one-call-site argument as
 * `boundBodyTail` directly below.
 *
 * THE CAP IS A PARAMETER, THE WALK IS NOT:
 * notify pushes keep this 280 default, while attend's reply funnel passes
 * `ATTEND_REPLY_CAP` (attend.ts) — a turn's ANSWER earned a chat-honest
 * length that a push notification never needs. Two reading budgets, ONE
 * boundary walk: the sentence-cut, grapheme and surrogate rules below are
 * exactly where a forked copy would silently drift, so the number moves and
 * nothing else does. Every guarantee here is stated against `cap`: output
 * length never exceeds it, marker included.
 */
export const HOOK_CHAT_CAP = 280;

export function capChatHead(text: string, cap: number = HOOK_CHAT_CAP): string {
  if (text.length <= cap) return text;
  // An over-cap body that is ALL whitespace has no head to keep; a bare
  // ellipsis body would read as a message that says nothing.
  if (text.trim() === '') return '';
  const limit = cap - 2; // room for the ' …' seam
  // The search window extends ONE unit past the cut limit so a boundary
  // whose following whitespace is the limit-th character is still seen —
  // the lookahead needs the character AFTER the punctuation, and a window
  // cut exactly at the limit hid it (an exactly-fitting
  // sentence fell through to the hard cut and shipped ".…").
  const window = text.slice(0, cap - 1);
  let cut = -1;
  // Sentence-enders beyond ASCII: fullwidth 。！？ and Arabic ؟ end
  // sentences in the scripts agents actually emit.
  const boundary = /[.!?…。！？؟](?=\s)|\n/g;
  for (let m = boundary.exec(window); m !== null; m = boundary.exec(window)) {
    const end = m[0] === '\n' ? m.index : m.index + 1;
    if (end > limit) break;
    cut = end;
  }
  if (cut > 0) return `${window.slice(0, cut).trimEnd()} …`;
  // Hard cut on a GRAPHEME boundary, not a code-unit one: stepping back a
  // lone surrogate protected pairs but split ZWJ sequences and combining
  // marks. Segment a probe slightly longer than the limit so a cluster
  // straddling it is seen whole and excluded whole.
  const probe = text.slice(0, cap + 16);
  let end = 0;
  for (const g of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(probe)) {
    const gEnd = g.index + g.segment.length;
    if (gEnd > limit) break;
    end = gEnd;
  }
  if (end === 0) {
    // Degenerate: the first grapheme alone exceeds the limit. Cut anyway,
    // surrogate-safe — a bounded wrong clip beats an unbounded right one.
    end = limit;
    const lastUnit = probe.charCodeAt(end - 1);
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 1;
  }
  return `${probe.slice(0, end).trimEnd()}…`;
}

/**
 * Markdown, degraded to chat prose (operator request: the first
 * real notification arrived reading "**Delivered — check your phone.**",
 * asterisks and all). An agent's last message is markdown; the phone renders
 * plain text, so the syntax is literal noise — and it BILLS against the chat
 * cap, spending the 280-character budget on rails instead of words, which is
 * why this runs BEFORE capChatHead in the funnel.
 *
 * A degrader, not a parser: each rule keeps the CONTENT and drops the
 * decoration, and every rule is shaped to leave non-markdown text alone —
 * `snake_case` and `2 * 3` survive because emphasis openers must hug a
 * non-space on the inside and a boundary on the outside. Fences and inline
 * code keep their text (the cap will clip detail anyway; deleting it here
 * would silently change what "head-keeping" keeps). Link text survives, URLs
 * go — a URL in a chat bubble is noise the operator cannot tap usefully at
 * 280 chars. Idempotent by construction: every output is a fixed point of
 * every rule, which the funnel's other two stages already promise.
 */
export function plainForChat(text: string): string {
  let s = text;
  s = s.replace(/^(?:```|~~~)[^\n]*\n?/gm, ''); // fence rails; content stays
  s = s.replace(/^#{1,6}\s+/gm, ''); // heading marks
  s = s.replace(/^>\s?/gm, ''); // blockquote marks
  s = s.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, ''); // rules
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'); // links: text, not URL
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2'); // bold
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?=[^\w*]|$)/g, '$1$2'); // italic
  s = s.replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?=[^\w_]|$)/g, '$1$2'); // italic
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1'); // strikethrough
  s = s.replace(/`([^`\n]+)`/g, '$1'); // inline code: content stays
  s = s.replace(/^[ \t]*[-*+]\s+/gm, '· '); // bullets, one clean glyph
  s = s.replace(/\n{3,}/g, '\n\n'); // collapse the gaps stripping leaves
  return s.trim();
}

/**
 * The SESSION TAG: a short, stable, human-usable handle
 * for one host session — `s-4fk2` — derived by digest so the raw
 * host-supplied session id never reaches a title, stderr, or --json.
 * Four hex chars is a display space, not an identity: the ledger
 * holds the full key, and a rare tag collision costs a human a moment of
 * reading two threads, never a route (routing is by msgId ref, not by tag).
 */
export function sessionTag(sessionKey: string): string {
  return `s-${createHash('sha256').update(sessionKey).digest('hex').slice(0, 4)}`;
}

export function composeHookBody(event: HookEvent, titleOverride: string | undefined): string {
  // `repo · s-4fk2: agent finished` — the tag is how the operator tells
  // three sessions in one repo apart BEFORE replying; the reply itself
  // routes by ref regardless. An operator-supplied --title is theirs and
  // gains nothing.
  const where = [
    event.projectTag,
    event.session ? sessionTag(event.session) : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
  const fallback = `${where ? `${where}: ` : ''}${
    event.kind === 'attention' ? 'agent needs attention' : 'agent finished'
  }`;
  const title = sanitizeForTerminal(titleOverride ?? fallback).slice(0, 200);
  const body = boundBodyTail(capChatHead(plainForChat(event.body)));
  return body ? `${title}\n${body}` : title;
}

// ---------------------------------------------------------------------------
// The on-disk queue — what "queue-and-exit" concretely means.
// ---------------------------------------------------------------------------

/**
 * Queue layout: `$TACENDUM_HOME/state/<name>/notify-queue/<ulid>.json`, one
 * entry per undelivered notification, 0600, under `state/` because the entry
 * holds PLAINTEXT — the same compartmentation argument as the message log
 * (config.ts `stateDir`): key-directory backups must not silently include it.
 *
 * Concurrency is claim-by-rename: a flusher renames `<id>.json` to
 * `<id>.json.claim.<pid>` before sending. rename() is atomic, so of two
 * concurrent hook processes exactly one owns an entry AT A TIME. That is
 * weaker than "never delivered twice": a claim older than CLAIM_STALE_MS is
 * presumed crashed and restored, so a claimer genuinely stalled past that
 * bound is raced by the restorer and one duplicate results — the same chosen
 * trade as a crash between receipt and unlink, because the alternative is a
 * stall losing the entry. What keeps that bound honest is that the claim's
 * mtime is FRESHENED at claim time: rename preserves the source file's
 * timestamp, so without the touch an 11-minute-old entry produced a claim
 * that was born "stale" and was restored (and re-sent) while its live claimer
 * was still mid-delivery. A failed send renames the claim back.
 *
 * Every entry carries the msgId its notification is sent under, minted ONCE
 * when the notification first exists and reused verbatim on every retry. The
 * server keys its queue on (recipient, msgId) — a re-send overwrites the same
 * row — and the phone (app messaging.ts) and CLI (`FileStores.hasSeen`) both
 * dedupe inbound frames on msgId, so a receipt that merely arrived late does
 * not become a second message on the phone when the retry lands.
 */
export function notifyQueueDir(account: string): string {
  return join(stateDir(account), 'notify-queue');
}

interface QueueEntry {
  v: 1;
  ts: number;
  to: string;
  body: string;
  /** The wire msgId this notification is sent under, on every attempt. */
  msgId: string;
  /** Ledger metadata: the host and its session key,
   * carried by the entry so a retry hours later still writes the SAME
   * ledger row a live delivery would have. */
  sess?: { host: string; key?: string; tag?: string };
}

/**
 * The outbound LEDGER row: msgId -> session, written at
 * delivery success into the spool's reserved dir:'out' shape. `read: true`
 * from birth — the operator "read" their own notification on the phone, and
 * an unread count polluted by the machine's own sends teaches people to
 * ignore it. `text: ''` on purpose: the body already exists on the phone and
 * transiently in the queue; a third plaintext copy that outlives both buys
 * routing nothing. Best-effort by design: a failed ledger row costs a reply
 * its route (the router says so honestly), never a delivery.
 */
function ledgerOutRow(
  account: string,
  msgId: string,
  to: string,
  sess: QueueEntry['sess'],
): void {
  try {
    new MessageLog(account).append({
      id: msgId,
      dir: 'out',
      peer: to,
      ts: Date.now(),
      tcm: '',
      text: '',
      read: true,
      ...(sess ? { sess } : {}),
    });
  } catch {
    // Routing degrades; delivery already happened. The router's
    // ended-session answer covers the miss.
  }
}

const QUEUE_ENTRY_RE = /^(\d{0,20}[0-9A-Z]{10,26})\.json$/;
const CLAIM_SUFFIX_RE = /\.claim\.\d+$/;

export function enqueueNotification(
  account: string,
  to: string,
  body: string,
  msgId: string = ulid(),
  sess?: QueueEntry['sess'],
): void {
  const dir = notifyQueueDir(account);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const entry: QueueEntry = { v: 1, ts: Date.now(), to, body, msgId, ...(sess ? { sess } : {}) };
  // DURABLE (the default), not crash-consistent: `cmdNotify` hard-exits the
  // process moments after this returns, and the whole point of the write is a
  // "queued" report the operator may act on — a queue entry still in the page
  // cache at power loss is a notification reported kept and silently gone.
  // One ~4-40ms fsync on the failure path of a command that is about to exit.
  writeFileAtomic(join(dir, `${ulid()}.json`), JSON.stringify(entry), { mode: 0o600 });
  pruneQueue(dir);
}

/** Age out, cap, and restore crashed claims. Runs on every queue touch —
 * there is no daemon, so the hook invocations ARE the schedule. */
function pruneQueue(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  // Crashed claims first, so the age/cap pass below sees the restored files.
  for (const name of names) {
    if (CLAIM_SUFFIX_RE.test(name)) {
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs > CLAIM_STALE_MS) {
          renameSync(path, join(dir, name.replace(CLAIM_SUFFIX_RE, '')));
        }
      } catch {
        // Another process restored or finished it; either way it is handled.
      }
      continue;
    }
    // `writeFileAtomic` stages `<entry>.<random>.tmp` and a rename that fails —
    // ENOSPC, a crash between write and rename — strands it holding PLAINTEXT
    // under a name no other pass here matches, forever. Swept once it is old
    // enough to be provably abandoned (a live staging window is milliseconds).
    if (name.endsWith('.tmp')) {
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs > CLAIM_STALE_MS) rmSync(path, { force: true });
      } catch {
        // Renamed into place or already removed; either way not stranded.
      }
    }
  }
  const entries = listQueueEntries(dir);
  const drop: string[] = [];
  const live: string[] = [];
  for (const name of entries) {
    // Read and parse are judged SEPARATELY, because they fail for different
    // reasons. A failed READ (EACCES after an operator chmod, EMFILE at the
    // descriptor ceiling) says nothing about the entry — deleting on it
    // destroyed a real notification over a transient fault — so the entry is
    // skipped this pass: not dropped, and not counted toward the cap either,
    // since the cap's rm could not tell it from a disposable one. A read that
    // SUCCEEDED and produced bytes that do not parse as an entry is corrupt
    // content, which no retry will improve: disposable.
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    try {
      const entry = JSON.parse(raw) as Partial<QueueEntry>;
      if (typeof entry.ts !== 'number') {
        drop.push(name); // parsed, but not an entry: corrupt content
      } else if (now - entry.ts > QUEUE_MAX_AGE_MS) {
        drop.push(name);
      } else {
        live.push(name);
      }
    } catch {
      drop.push(name); // valid read, invalid JSON: corrupt content
    }
  }
  // ULID names sort oldest-first, so the overflow to drop is the front.
  for (const name of [...drop, ...live.slice(0, Math.max(0, live.length - QUEUE_MAX_ENTRIES))]) {
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      // A file another process already removed is a file already handled.
    }
  }
}

/** Unclaimed entry names, oldest first (ULIDs sort chronologically). */
function listQueueEntries(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => QUEUE_ENTRY_RE.test(n)).sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The cursor text cache — the two-hook dance's shared state.
// ---------------------------------------------------------------------------

export function cursorCacheDir(account: string): string {
  return join(stateDir(account), 'cursor-cache');
}

/** Per-entry cache bound, tail kept (the stop wants the conclusion). Far
 * above the 2 KB send cap on purpose — the omission marker composed at send
 * states the TRUE dropped count for anything under this — but a bound all the
 * same: an unbounded synchronous write of whatever a host handed us is both a
 * plaintext spool with no ceiling and a hook that blocks on a huge payload. */
const CURSOR_CACHE_MAX_BYTES = 1024 * 1024;

/** At most this many cached conversations per account, oldest evicted first —
 * the same argument as QUEUE_MAX_ENTRIES: no unbounded plaintext spool. */
const CURSOR_CACHE_MAX_ENTRIES = 100;

/**
 * A conversation id mapped INJECTIVELY to a filename-safe key: the SHA-256 of
 * the id, hex. Hashing is not cryptography here (a
 * filename, not a secret); what it buys is that two DISTINCT ids can never
 * share a file. The previous shape stripped disallowed characters and
 * truncated, and a lossy map is not injective: 'session/a' and 'sessiona'
 * collided, so stopping one conversation sent — and consumed — the OTHER
 * conversation's plaintext. Only the empty id is refused: it cannot be
 * disambiguated between sessions, and a shared fallback file is precisely the
 * concurrent-session cross-read the per-id key exists to prevent.
 */
function cursorCacheKey(conversationId: string): string | null {
  if (conversationId.length === 0) return null;
  return createHash('sha256').update(conversationId, 'utf8').digest('hex');
}

/** Sweep cache files past the staleness bound. Every cursor invocation runs
 * it, so a crashed session's plaintext outlives it by at most the bound. */
function sweepCursorCache(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    try {
      if (now - statSync(join(dir, name)).mtimeMs > CURSOR_CACHE_STALE_MS) {
        rmSync(join(dir, name), { force: true });
      }
    } catch {
      // Already gone — concurrent sweep or a stop consumed it.
    }
  }
}

/** Evict oldest cache entries so at most CURSOR_CACHE_MAX_ENTRIES - 1 OTHER
 * conversations remain before `keepName` is written. */
function capCursorCacheEntries(dir: string, keepName: string): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.txt') && n !== keepName);
  } catch {
    return;
  }
  const excess = names.length - (CURSOR_CACHE_MAX_ENTRIES - 1);
  if (excess <= 0) return;
  const aged = names
    .map((n) => {
      try {
        return { n, m: statSync(join(dir, n)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { n: string; m: number } => x !== null)
    .sort((a, b) => a.m - b.m);
  for (const { n } of aged.slice(0, excess)) {
    try {
      rmSync(join(dir, n), { force: true });
    } catch {
      // Consumed or swept concurrently — either way no longer over the cap.
    }
  }
}

/** Cache a response's text for the stop event, UNTRUNCATED below the byte
 * ceiling — the truncation rule is applied only at `composeHookBody`, the
 * one funnel; a truncation here too was the two-call-site defect (the
 * second pass clipped an already-clipped body). Past the ceiling the HEAD
 * is kept, because the funnel's chat cap keeps the head: a tail-keeping
 * ceiling in front of a head-keeping cap handed compose the END of a huge
 * response and the outcome sentence was gone before the cap ever ran.
 * The spool stays bounded by overwrite (one file per conversation — `stop`
 * wants the LAST response), consume-on-stop, the staleness sweep, and the
 * entry cap above. */
export function cacheCursorText(account: string, conversationId: string, text: string): boolean {
  const key = cursorCacheKey(conversationId);
  if (key === null) return false;
  const dir = cursorCacheDir(account);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweepCursorCache(dir);
  capCursorCacheEntries(dir, `${key}.txt`);
  const bounded = headWithinBytes(text, CURSOR_CACHE_MAX_BYTES);
  writeFileAtomic(join(dir, `${key}.txt`), bounded, { mode: 0o600 }, 'crash-consistent');
  return true;
}

/** What `takeCursorText` hands back: the text, and the commitment point. */
export interface TakenCursorText {
  text: string;
  /** Delete the claimed file. Called only once the text has been DELIVERED or
   * durably queued — never before, so no moment exists at which the only copy
   * of a response lives exclusively in this process's memory. */
  commit: () => void;
}

/**
 * Claim the cached text for a conversation, if any.
 *
 * CLAIM-BY-RENAME, exactly as the notify queue does it, and for the same two
 * reasons. Read-then-unlink was not atomic: two stop hooks could both read
 * before either unlinked and both send. And unlink-before-delivery meant a
 * process killed after the unlink took the only copy of the response with it.
 * rename() gives the file to exactly one taker, and the claimed file stays on
 * disk until `commit` — a taker that dies mid-delivery leaves it for the
 * staleness sweep (bounded, 24 h) instead of leaving nothing. The mtime is
 * freshened at claim so the sweep judges the CLAIM's age, not the entry's.
 */
export function takeCursorText(account: string, conversationId: string): TakenCursorText {
  const none: TakenCursorText = { text: '', commit: () => {} };
  const key = cursorCacheKey(conversationId);
  if (key === null) return none;
  const dir = cursorCacheDir(account);
  sweepCursorCache(dir);
  const path = join(dir, `${key}.txt`);
  const claimPath = `${path}.taking.${process.pid}`;
  try {
    const now = new Date();
    utimesSync(path, now, now);
    renameSync(path, claimPath);
  } catch {
    return none; // never cached, already consumed, or swept: the finish still notifies
  }
  try {
    const text = readFileSync(claimPath, 'utf8');
    return {
      text,
      commit: () => {
        try {
          rmSync(claimPath, { force: true });
        } catch {
          // Swept concurrently; the plaintext is gone either way.
        }
      },
    };
  } catch {
    return none; // claimed but unreadable; the sweep collects the claim
  }
}

// ---------------------------------------------------------------------------
// Delivery — the same wire steps as cmdSend, minus everything notify not need.
// ---------------------------------------------------------------------------

/** Injectable for tests; the default does the real protocol work. */
export type DeliverFn = (args: {
  account: string;
  to: string;
  body: string;
  /** The wire id, minted ONCE per notification by the caller and reused
   * verbatim on every retry — the server and both receivers dedupe on it. */
  msgId: string;
  report: Reporter;
  budgetMs: number;
}) => Promise<{ msgId: string; state: string }>;

/**
 * `sendEncrypted` (send.ts) with notify's own posture on the seams — the wire
 * sequence itself, connect-before-any-ratchet-work included, has exactly one
 * owner and it is not this function. (It used to be: this file carried a
 * hand-mirrored copy of cmdSend's sequence, the order defect was fixed HERE
 * and survived in the other two copies — the repo's two-call-site disease at
 * its most literal.)
 *
 * What is notify's own, each deliberate:
 *   - no `--drain` and no inbound attachment: a hook must exit inside the
 *     deadline, and an unconsumed frame is simply redelivered to the next
 *     `listen`/`sync` (the server keeps it until acked);
 *   - the receipt wait is bounded by the caller's remaining budget, not the
 *     flat 10 s;
 *   - the msgId is the CALLER's, minted once per notification and reused on
 *     every retry (see the queue header for why);
 *   - the identity-change wording says "queued, not sent", because that is
 *     what runNotify does with the refusal.
 */
async function deliverNotification(args: {
  account: string;
  to: string;
  body: string;
  msgId: string;
  report: Reporter;
  budgetMs: number;
}): Promise<{ msgId: string; state: string }> {
  const { account, to, body, msgId, report } = args;
  const stores = new FileStores(account);
  const auth = new AuthSession(account, stores);

  try {
    const { receipt } = await sendEncrypted({
      stores,
      auth,
      to,
      body,
      msgId,
      receiptTimeoutMs: Math.max(250, Math.min(args.budgetMs, 10_000)),
      events: {
        connecting: () => report.status('connecting…'),
        fetchingBundle: () =>
          report.status('no session with the recipient; fetching prekey bundle'),
        awaitingReceipt: () => report.status('waiting for receipt…'),
      },
    });
    return { msgId, state: receipt.type === 'receipt' ? receipt.state : 'sent' };
  } catch (err) {
    if (isIdentityChange(err)) {
      // establishSession has already recorded the pending change (the
      // rule lives at the raise site — messaging.ts); this wording exists
      // so the operator's log names the accepting command, per the
      // identity-change invariant in cmdTrust's doc block.
      throw new CliError(
        EXIT.SAFETY,
        `SAFETY NUMBER CHANGED for the recipient — the notification was queued, not sent. ` +
          `Verify out of band (tacendum safety ${account} ${to}); ` +
          `to accept, run: tacendum trust ${account} ${to}`,
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The orchestrator.
// ---------------------------------------------------------------------------

export interface NotifyDeps {
  deliver?: DeliverFn;
  /** Payload source for the stdin hosts; injectable so tests need no fd 0. */
  readStdin?: () => string | Promise<string>;
  deadlineMs?: number;
}

/**
 * One result writer for every outcome. Human results go to STDERR, not
 * stdout: Gemini parses a hook's stdout as JSON and its docs forbid any other
 * stdout text, and Cursor reads stdout for hook directives — so prose on
 * stdout is at best noise and at worst a misparsed directive. Under `--json`
 * the one-object stdout contract holds as everywhere else in this CLI (none
 * of these objects contains a field any host interprets as a directive).
 */
function result(report: Reporter, record: Record<string, unknown>, human: string): void {
  if (report.json) {
    report.emit(record, '');
    return;
  }
  report.note(human);
}

function usage(): string {
  return 'usage: tacendum notify --hook claude|codex|gemini|cursor --account <name> [--to <id>] [--title T]';
}

function requireHost(args: ParsedArgs): HookHost {
  const host = flagString(args, '--hook');
  if (host === undefined) throw new CliError(EXIT.USAGE, usage());
  if (!(HOOK_HOSTS as readonly string[]).includes(host)) {
    // The VALUE is not echoed: this is argv, and a misconfigured
    // hook line can shift any later argument — including a payload — into
    // this slot. The allowed set is the whole diagnosis anyway.
    throw new CliError(EXIT.USAGE, `--hook takes one of: ${HOOK_HOSTS.join(', ')}`);
  }
  return host as HookHost;
}

/**
 * The testable core: parses, dispatches, sends/queues, RETURNS an exit code.
 * Throws only for setup errors (EXIT.USAGE, see the module header); once the
 * invocation is recognizably a hook event, every failure path returns EXIT.OK.
 */
export async function runNotify(
  argv: string[],
  report: Reporter,
  deps: NotifyDeps = {},
): Promise<ExitCode> {
  const args = parseArgs(argv, { value: ['--hook', '--account', '--to', '--title'] });
  const host = requireHost(args);
  const account = flagString(args, '--account');
  if (account === undefined) throw new CliError(EXIT.USAGE, usage());
  const profile = loadProfile(account); // the usual unregistered-name refusal
  const toFlag = flagString(args, '--to');
  const to = toFlag !== undefined ? resolveRecipient(toFlag) : profile.ownerUserId;
  if (to === undefined) {
    throw new CliError(
      EXIT.USAGE,
      `${account} is not paired, so notify has no recipient — run: ` +
        `tacendum pair ${account} <owner-id>, or pass --to <id>`,
    );
  }
  const title = flagString(args, '--title');

  const deliver = deps.deliver ?? deliverNotification;
  const deadlineMs = deps.deadlineMs ?? NOTIFY_DEADLINE_MS;
  const readStdin = deps.readStdin ?? readHookStdin;

  let parsed: ParsedHook;
  try {
    parsed =
      host === 'codex'
        ? // Codex APPENDS the payload, so it is the LAST positional — flags
          // configured after it in config.toml cannot displace it.
          parseCodexHook(args.positionals[args.positionals.length - 1])
        : host === 'claude'
          ? parseClaudeHook(await readStdin())
          : host === 'gemini'
            ? parseGeminiHook(await readStdin())
            : parseCursorHook(await readStdin());
  } catch (err) {
    if (!(err instanceof HookPayloadError)) throw err;
    // A malformed payload is a host-version drift, not an agent failure.
    // Exit 0 (nothing to send, nothing to queue), but say so loudly: silence
    // here is a notifier that stopped notifying with nobody told.
    result(
      report,
      { ok: false, action: 'unparsed', host, error: err.message },
      `notify --hook ${host}: ${err.message} — nothing sent`,
    );
    return EXIT.OK;
  }

  if (parsed.action === 'ignore') {
    result(report, { ok: true, action: 'ignored', host, reason: parsed.reason }, `notify: ${parsed.reason}`);
    return EXIT.OK;
  }

  if (parsed.action === 'cache') {
    const cached = cacheCursorText(account, parsed.conversationId, parsed.text);
    result(
      report,
      { ok: true, action: cached ? 'cached' : 'uncacheable', host },
      cached
        ? 'notify: cached the response text for this conversation’s stop event'
        : 'notify: no usable conversation id — the stop event will send without text',
    );
    return EXIT.OK;
  }

  // The cursor-cache staleness sweep runs on EVERY send-path invocation, not
  // only cursor's own: there is no daemon, so if cursor never fires again a
  // final cached response would strand forever unless the other hosts' hooks
  // (which do keep firing) sweep it. Cheap — one readdir of a usually-absent
  // directory.
  sweepCursorCache(cursorCacheDir(account));

  let commitTakenText: () => void = () => {};
  let event: HookEvent;
  if (parsed.action === 'send-cached') {
    const taken = takeCursorText(account, parsed.conversationId);
    commitTakenText = taken.commit;
    event = { ...parsed.event, body: taken.text };
  } else {
    event = parsed.event;
  }
  // THE ART. 50 MARKER (ai-origin.ts holds the whole argument): a
  // hook notification is agent-authored content, so it crosses the same
  // funnel attend's replies do — wrapped into the marked `msg` envelope
  // under the operator's one attestation (attend.json's `markerMinAppBuild`),
  // byte-identical bare text without it. Marked HERE, before the deliver
  // and before any queue write, so the retry path resends exactly what the
  // live path would have sent.
  //
  // OWNER ONLY (the consent remediation): the attestation speaks for the
  // OWNER's phone and no other device. A `--to` recipient's build is
  // unknown, and on a pre-`msg` CLI the wrapped body is not degraded but
  // DROPPED whole — renderBody has no `case 'msg'`, `maySpool` refuses the
  // row, and inbound never writes it — so a non-owner send stays byte-bare.
  const body = markAgentBody(
    composeHookBody(event, title),
    to === profile.ownerUserId && markerAttested(account),
  );
  // Ledger metadata, fixed here so the live path and the queue retry write
  // the identical row.
  const sess: QueueEntry['sess'] = {
    host,
    ...(event.session ? { key: event.session } : {}),
    ...(event.projectTag ? { tag: event.projectTag } : {}),
  };

  // -- The never-block core: everything network-shaped below this line is
  //    raced against ONE deadline, and every failure ends in queue + EXIT.OK.
  const startedAt = Date.now();
  const remaining = (): number => Math.max(0, deadlineMs - (Date.now() - startedAt));
  const underDeadline = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new CliError(EXIT.TIMEOUT, `notify gave up after ${deadlineMs} ms`)),
            remaining(),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const queueDir = notifyQueueDir(account);
  pruneQueue(queueDir);
  let flushed = 0;
  let sendFailure: unknown = null;

  // Older queued notifications go FIRST, and — now that the live event is
  // also refused a start below the same budget floor — a starved run queues
  // the live event rather than jumping it over unflushed older entries, so
  // within one account the owner reads notifications in the order they
  // happened. A flush failure still skips the live attempt entirely: the
  // network is down, and the remaining budget is better spent exiting.
  for (const name of listQueueEntries(queueDir)) {
    if (remaining() < FLUSH_FLOOR_MS) break;
    const entryPath = join(queueDir, name);
    const claimPath = `${entryPath}.claim.${process.pid}`;
    let entry: QueueEntry;
    try {
      // The claim's mtime must be the CLAIM's age, not the entry's: rename
      // preserves the source's timestamp, and an entry older than
      // CLAIM_STALE_MS would otherwise produce a claim that is stale AT
      // BIRTH — a rival's prune then restores it mid-delivery and both send
      // (see the queue header). Touch first: if a rival claims between the
      // touch and the rename, the rename gets ENOENT and this process moves
      // on; a freshened mtime on the rival's claim is harmless.
      const now = new Date();
      utimesSync(entryPath, now, now);
      renameSync(entryPath, claimPath); // atomic claim: a rival gets ENOENT
      entry = JSON.parse(readFileSync(claimPath, 'utf8')) as QueueEntry;
    } catch {
      continue; // claimed by a rival, or unreadable (pruneQueue's problem)
    }
    // Entries written before msgId existed carry none; their filename ULID is
    // stable across retries, so it stands in rather than a per-attempt mint.
    const entryMsgId =
      typeof entry.msgId === 'string' && entry.msgId !== ''
        ? entry.msgId
        : name.slice(0, -'.json'.length);
    try {
      await underDeadline(
        deliver({
          account,
          to: entry.to,
          body: entry.body,
          msgId: entryMsgId,
          report,
          budgetMs: remaining(),
        }),
      );
      rmSync(claimPath, { force: true });
      flushed += 1;
      ledgerOutRow(account, entryMsgId, entry.to, entry.sess);
    } catch (err) {
      sendFailure = err;
      try {
        renameSync(claimPath, entryPath); // give it back for the next run
      } catch {
        // The claim file survives; the stale-claim sweep restores it.
      }
      break;
    }
  }

  // Minted ONCE, here — before the first attempt — and reused by the queue
  // entry if that attempt fails: a fresh id per attempt turned ordinary
  // receipt latency into duplicates (frame accepted, receipt after the
  // deadline, retry re-sent the same plaintext under a NEW id the phone could
  // not dedupe).
  const liveMsgId = ulid();

  if (sendFailure === null && remaining() >= FLUSH_FLOOR_MS) {
    try {
      const { msgId, state } = await underDeadline(
        deliver({ account, to, body, msgId: liveMsgId, report, budgetMs: remaining() }),
      );
      commitTakenText();
      ledgerOutRow(account, liveMsgId, to, sess);
      result(
        report,
        // No `to` (or any other caller-supplied value) in the record — the no-leak rule
        // covers --json output too. msgId is minted here; state is the
        // schema-validated receipt enum.
        { ok: true, action: 'notified', host, msgId, state, ...(flushed ? { flushed } : {}) },
        `notified ${state}${flushed ? ` (+${flushed} queued)` : ''}`,
      );
      return EXIT.OK;
    } catch (err) {
      sendFailure = err;
    }
  } else if (sendFailure === null) {
    // The flush consumed the budget: starting a send now would begin work the
    // deadline has already spent. Queue the live event instead — order kept.
    sendFailure = new CliError(EXIT.TIMEOUT, `notify gave up after ${deadlineMs} ms`);
  }

  // ANY failure ends here: queue the event, tell stderr why, exit 0. The
  // message never contains the body (every CliError in this package is
  // written leak-free; the queue file is where the plaintext goes) — and
  // it is sanitized and bounded anyway, because a CliError from the API layer
  // carries the SERVER's error code and detail verbatim (api.ts), and a
  // hostile server must not reach the host's stderr log with a newline, a
  // terminal escape, or a megabyte.
  const reason = sanitizeServerField(
    sendFailure instanceof Error ? sendFailure.message : String(sendFailure),
    300,
  );
  try {
    enqueueNotification(account, to, body, liveMsgId, sess);
    commitTakenText();
    result(
      report,
      { ok: true, action: 'queued', host, ...(flushed ? { flushed } : {}) },
      // Only notify flushes this queue — there is no send-path flush, and
      // saying there was sent operators to wait on a retry that never comes.
      `notify: send failed (${reason}) — queued; the next notify from this account will retry it`,
    );
  } catch (err) {
    // Disk refused too. The notification is lost; exiting non-zero would not
    // bring it back and could block the agent, so the loss is at least LOUD.
    // `commitTakenText` is deliberately NOT called: a claimed cursor cache
    // file is now the only copy of the text, and it stays on disk (bounded by
    // the 24 h sweep) where an operator alerted by this message can read it.
    result(
      report,
      { ok: false, action: 'dropped', host },
      `notify: send failed (${reason}) and the queue write also failed ` +
        `(${sanitizeServerField(err instanceof Error ? err.message : String(err), 300)}) — ` +
        `notification lost`,
    );
  }
  return EXIT.OK;
}

/** How long a host gets to hand over its stdin payload. Hosts write the JSON
 * and close the pipe within milliseconds; this bound exists for the writer
 * that never closes, which a synchronous read waited on forever — before the
 * send deadline even existed. Whatever has arrived when it expires is used
 * (a complete payload with an unclosed fd parses fine; an incomplete one
 * takes the loud unparsed path, exit 0). */
const STDIN_READ_MAX_MS = 3_000;

/** More stdin than any host payload could be. Past it the rest is not read:
 * an unbounded buffer of host-supplied bytes is a memory bound broken by
 * whoever writes fastest. */
const STDIN_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Stdin, read whole — bounded in TIME and SIZE (both above). The TTY guard
 * mirrors composeBody's (main.ts): with no pipe on fd 0 a read would sit on
 * the keyboard — and this command's contract is that it never blocks
 * anything. It used to be `readFileSync(0)`, which on a non-TTY writer that
 * never closes blocked the event loop forever with no timer able to fire.
 *
 * The stream parameter exists for tests; production passes nothing.
 */
export function readHookStdin(stdin: typeof process.stdin = process.stdin): Promise<string> {
  if (stdin.isTTY) {
    throw new CliError(
      EXIT.USAGE,
      'this host delivers its payload on stdin — the command is meant to be ' +
        'run by the host, not typed (codex is the argv exception)',
    );
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const stop = (): void => {
      try {
        stdin.destroy();
      } catch {
        // A stream that refuses to die still cannot keep `finish` from running.
      }
      finish();
    };
    const timer = setTimeout(stop, STDIN_READ_MAX_MS);
    stdin.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      chunks.push(buf);
      total += buf.length;
      if (total > STDIN_MAX_BYTES) stop();
    });
    stdin.on('end', finish);
    stdin.on('close', finish);
    stdin.on('error', finish);
  });
}

/**
 * The wired entry point: run, then EXIT THE PROCESS.
 *
 * Not main.ts's usual resolve-and-return, deliberately. A deadline race
 * abandons its loser, and an in-flight TCP dial to an unreachable host keeps
 * the event loop alive for the OS connect timeout (~75 s) — a hook that hangs
 * 75 s after "returning" has blocked the agent, which is the one thing this
 * command exists to never do. The stdout callback lets the (one-line) result
 * drain first; the unref'd timer covers a stream whose callback never fires
 * without itself keeping the process alive.
 *
 * Setup errors (EXIT.USAGE) still throw OUT of this function so main.ts's
 * handler formats them — that path already ends in process.exit.
 */
export async function cmdNotify(argv: string[], report: Reporter): Promise<void> {
  const code = await runNotify(argv, report);
  report.done();
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500).unref();
  process.stdout.write('', () => process.exit(code));
}
