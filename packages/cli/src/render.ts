/**
 * Inbound body rendering.
 *
 * A decrypted body is not necessarily a message. The app carries structured
 * envelopes inside the ratchet — `react`, `profile`, `edit`, `del`, `image`,
 * `shot`, `timer`, `vault`, `read`, `reply`, plus the whole `call.` namespace
 * — and until now the CLI printed every one of them verbatim. So a phone user
 * tapping a thumbs-up produced this on a developer's terminal:
 *
 *     [01J8...] {"tcm":"react","ref":"01J8...","ofs":false,"emoji":"..."}
 *
 * which is worse than useless: it is unreadable, it is unstable to grep
 * against, and for `vault` it would print a door code or an SSH key into a CI
 * log. This module is the one place that decides what a body LOOKS like.
 *
 * THE SPLIT MIRRORS THE APP (app/src/envelope.ts `isCarrierEnvelope`), and
 * that is the point rather than a convenience: two clients on one protocol
 * must agree on what counts as a message. A reaction is not a message on the
 * phone, so it is not a line of stdout here.
 *
 *   carrier=true   transport. It changes state somewhere; it is not something
 *                  a person said. Never on stdout. `main.ts` puts it on
 *                  stderr as a note, so an operator watching a stream is not
 *                  left wondering whether the CLI crashed.
 *   text=''        say nothing at all, on either stream. Only the `call.`
 *                  namespace, which is signalling — an older peer must not
 *                  have its terminal filled by a newer peer placing a call.
 *   carrier=false  a message. `[<from>] <text>` on stdout, the shape the e2e
 *                  gates already assert.
 *
 * Deliberately NOT importing the app's zod schemas: `app/` is another
 * workstream's tree and is not a dependency of this package. The routing here
 * is on the DECLARED `tcm` — readable even from a truncated or future-shaped
 * frame — with defensive field reads underneath, which is exactly the
 * forward-compatibility posture the app documents. An unknown kind renders as
 * a notice, never as raw JSON and never as silence.
 */

/** How a structured body announces itself. Must match app/src/envelope.ts. */
const ENVELOPE_SENTINEL = '{"tcm":';

/** Everything under `call.` is signalling, never conversation. */
const CALL_NAMESPACE = 'call.';

/**
 * The reserved machine-carrier namespace. Nothing emits an
 * `x.*` kind today; the reservation exists so that whatever eventually does
 * (application-level acknowledgements, structured task handoffs) is INVISIBLE
 * to builds that predate it instead of noisy in them. Routed on the prefix,
 * BEFORE parsing, exactly as `call.` is — an unparseable or future-shaped
 * `x.*` body must stay silent too, which a post-parse branch cannot promise.
 */
const EXTENSION_NAMESPACE = 'x.';

/** The room namespace. Routed to the injected room
 * renderer, which owns store context this pure module must not. */
const GROUP_NAMESPACE = 'grp.';

/**
 * U+FFFC OBJECT REPLACEMENT CHARACTER — one per mention, standing where each
 * name goes (`MENTION_MARK`, app/src/envelope.ts). Ordinal, not offsets, and
 * deliberately: the Nth mark is the Nth id in `who`, so there is no range
 * arithmetic to desynchronise, and a count mismatch fails visibly (a dropped
 * mark) instead of silently mentioning the wrong person.
 */
const MENTION_MARKS = /￼/g;

/** Longest stored peer name a resolved mention will show — `profile`'s own
 * bound (`str(env.n, 40)` below), re-applied because the names FILE is
 * hand-editable and a file is an input too (the stores.ts precedent).
 * Exported so room sentences (`room-render.ts` personLabel) stay bound to
 * the same constant rather than growing a drifting copy. */
export const MENTION_NAME_MAX = 40;

/** Shown for structure this build cannot read. Mirrors the app's wording. */
export const UNSUPPORTED_TEXT = 'unsupported message — update tacendum-cli';

/**
 * The `tcm` a body CLAIMS, read without requiring the whole body to parse.
 *
 * The character class carries digits, `-` and `_` because of what this regex
 * GATES: a kind it fails to recognise never reaches the `call.` / `x.` /
 * `grp.` namespace routing, so it falls through to the visible unsupported
 * line. The whole value of the reserved `x.` namespace is that a future kind
 * is INVISIBLE to builds that predate it, and a namespace whose names may
 * only be lowercase-and-dots is a trap: the first extension called
 * `x.ack2` or `x.task-handoff` would be noisy on every already-deployed
 * build, and by then it is unfixable, because the old builds are the problem.
 *
 * Found by the three-client e2e gate, whose `x.e2e-probe` carrier printed
 * "unsupported message" on a real wire while every unit test passed — the
 * tests all used conformant names. The app carries the identical pattern for
 * the identical reason (`app/src/envelope.ts`); the two are duplicated rather
 * than shared, which is a real smell and is recorded as one.
 *
 * Widening grants a peer no capability they lacked: `x.anything` was already
 * silent, so this only decides whether silence also covers realistic names.
 */
const DECLARED_TCM = /^\{"tcm":"([a-z][a-z0-9._-]{0,31})"/;

/**
 * Terminal control characters, which anything a peer chose must not carry.
 *
 * This text goes straight to a terminal, and a peer can put any bytes they
 * like in a message body. An ESC sequence can retitle the window, move the
 * cursor, or repaint a line that has already been printed — which is enough to
 * forge a `CALL ...` line, or to hide one. A bare CR is the cheap version of
 * the same attack: it rewrites the line the CLI just wrote.
 *
 * TAB (09) and LF (0A) are the two exceptions, because a multi-line
 * notification — a stack trace, a build-log tail, the entire premise of
 * `--title` plus stdin — has to stay legible. Everything else in C0 (including
 * ESC 1B and CR 0D), DEL (7F) and C1 (80-9F) goes.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * Where a LINE ENDS, according to everyone who reads this program's output.
 *
 * `prefixLines` below and `sanitizeServerField` above both turn on this one
 * question, and the answer is not "LF". It is the union of what the consumers
 * of these two streams honour, because a boundary any ONE of them sees is a
 * boundary a peer can forge a line at:
 *
 *   a terminal        LF, and CR — which does not open a line so much as
 *                     repaint the one already written.
 *   grep / awk / cut  LF alone. This is the e2e gate's provenance scanner,
 *                     and the operator grepping a log during an incident.
 *   a Unicode-aware   LF, CR, and U+2028 LINE SEPARATOR / U+2029 PARAGRAPH
 *   or JS reader      SEPARATOR: `/^GCALL /m` matches after all four in every
 *                     JS log processor, because LS and PS are LineTerminators
 *                     in ECMAScript itself. Python's `str.splitlines` adds
 *                     VT, FF and NEL on top of those.
 *   a text editor     whatever Unicode says, which is all of the above.
 *
 * So the set is LF, CR, CRLF, VT, FF, NEL, LS and PS. `sanitizeForTerminal`
 * strips CR, VT, FF and NEL upstream, so those arms never fire on a body that
 * came through `renderBody` — they are here because a rule about what ends a
 * line must not be true only for as long as some OTHER module's rule keeps
 * holding. That was an earlier revision's argument for including CR, and an earlier revision is
 * what it looks like when the argument is applied by hand instead of by
 * principle: the set covered CR, which cannot occur, and missed LS and PS,
 * which can — nothing strips them, and nothing should, because they are not
 * control bytes and a peer may put one in a message for the ordinary reason.
 *
 * DELIBERATELY NOT IN THE SET: the rest of C0 (including 1C-1E, which Python
 * splits on and nothing else does), DEL and C1. Those are stripped outright
 * rather than split on, because none of them is a line a human meant to
 * write. This set is the breaks a legitimate message may legitimately CONTAIN.
 */
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;
/** The same set as a RUN, for the fields that flatten instead of splitting. */
const LINE_BREAK_RUN = /(?:\r\n|[\n\r\v\f\u0085\u2028\u2029])+/g;

export interface RenderedBody {
  /** The declared kind, '' for ordinary text. */
  tcm: string;
  /** True for transport: never a line of stdout. */
  carrier: boolean;
  /** What to show. '' means show nothing on any stream. */
  text: string;
  /** reply only: the answered message's msgId, shape-checked (26 chars). */
  ref?: string;
  /** reply only: the quoted message was the REPLIER's own. */
  ofs?: boolean;
  /**
   * The display name a `profile` envelope carries, sanitized and bounded.
   * Present only for that kind. Surfaced as its own field because `contacts`
   * needs the NAME, not the sentence about it — re-parsing our own rendered
   * text to get it back out would make the display string a wire format.
   */
  peerName?: string;
  /**
   * For `grp.msg` only: the kind of the INNER body, after the room unwrap —
   * '' for plain text. Surfaced so `maySpool` can apply the "conversational
   * text only" rule to the wrapped content without re-parsing the body, which
   * would be the second copy of the switch the design forbids.
   */
  innerTcm?: string;
  /**
   * For `grp.msg` only: the room id (`env.g`) — the ULID-class metadata the
   * room trigger predicate keys on.
   * Set by the room wrapper (room-render.ts), which is the only place env.g
   * is in scope; the spool persists it on grp.msg rows only (inbound.ts).
   */
  grp?: string;
  /**
   * mention (bare or room-wrapped): the STRUCTURED envelope's `who[]` names
   * this account. Computed from ids in the arm where
   * `id === names.selfId` already resolves `@you` — rendered TEXT never sets
   * it (a plain-text "@name" must never read as a mention — deliberate rule), and an
   * absent `names` fails closed. Present only when true.
   */
  men?: boolean;
  /**
   * `grp.msg` only: the room wrapper carried the Art. 50 AI-origin
   * marker (`env.ai === true`), so this author speaks AI-marked in the room.
   * Set by room-render.ts (the only place the wrapper is in scope) and
   * persisted per row by inbound.ts, where the room send path reads it back
   * to identify agent members. Present only when true.
   */
  ai?: boolean;
}

/**
 * The seam through which room bodies are rendered.
 *
 * Rendering a `grp.*` body needs things this module deliberately does not
 * have: the room store (owner, name, presence), this account's own id, and
 * the AUTHENTICATED sender of the frame. The inbound paths own all three, so
 * they inject the renderer per frame; this module only routes to it. What the
 * seam preserves is the one-switch rule — the injected renderer calls
 * `renderBody` back for the INNER body of a `grp.msg`, so an image in a room
 * is the same image branch a 1:1 image is.
 */
export type GroupBodyRenderer = (declared: string, body: string) => RenderedBody;

/**
 * The seam through which a mention's ids become names.
 *
 * A mention travels as IDS — because names in this product are LOCAL, the
 * literal "@Ana" on the wire would render one person's private name for
 * someone on eleven other screens — and this pure module owns no name store.
 * The inbound paths do, so they inject the resolution per frame, exactly as
 * they inject the room renderer. Optional, and every absence fails toward
 * the placeholder: a surface that injects nothing still never prints a ULID.
 */
export interface MentionNames {
  /** The local account's own id. Its mention renders as `@you`. */
  selfId: string;
  /** This client's stored name for a peer; undefined when it has none. */
  nameFor: (id: string) => string | undefined;
}

/**
 * ---------------------------------------------------------------------------
 * THE CREDENTIAL CHOKEPOINT.
 *
 * AN ERROR MAY NEVER REPRODUCE A CREDENTIAL, and until this
 * existed that rule was enforced by asking, at each individual sink, "does
 * this text contain the secret?" — `quotesCredential`, called from the
 * transport catch in api.ts and from doctor's `me.json()` catch. Two sinks,
 * both on EXCEPTION paths. The rule is not about exceptions.
 *
 * WHAT GOT PAST IT, all three with a perfectly well-formed token that this
 * client minted, stored and presented without anything refusing anything:
 *
 *   - a 500 whose `{error:{detail}}` is the bearer. `request()` copies server
 *     detail into its `CliError`, which lands on stderr and in the `--json`
 *     error object. No exception path is involved; the belt was not there.
 *   - a 2xx whose CONTENT-TYPE is the bearer, named by `requestJson`'s
 *     not-JSON refusal inside a 64-character bound that cuts nothing off a
 *     43-character token.
 *   - `/v1/me` answering with the bearer as its `userId` (printed whole by
 *     doctor) or as a non-JSON BODY, where V8's `SyntaxError` quotes the first
 *     TEN characters — and the belt compared a SIXTEEN-character probe, so it
 *     answered "no" and doctor printed the partial secret.
 *
 * So the question moves off the sinks and onto the one path all of them share.
 * Every one of those strings crosses `sanitizeForTerminal` — directly, or
 * through `sanitizeServerField`, which calls it — because this module is
 * already where this package decides what text may look like on its way out.
 * Redaction goes THERE, once, and every present and future sink inherits it.
 * A rule with N call sites is a rule with N+1 chances to be forgotten.
 *
 * WHY REDACT RATHER THAN WITHHOLD. The old belt suppressed the whole message,
 * on the reasoning that editing text we do not control is how a redactor gets
 * outrun. That reasoning applies to a redactor working from a PATTERN — "what
 * does a secret look like" — and this one does not: the needle is a literal
 * value this process is holding, so there is nothing to guess and nothing to
 * outrun. Redacting keeps the diagnosis (the route, the status, the errno, the
 * server's code) and removes exactly the bytes that may not be shown, which is
 * strictly better for the operator than a line that says only that something
 * was withheld.
 *
 * WHAT COUNTS AS A DISCLOSURE: `CREDENTIAL_RUN` characters. A token is 32
 * random bytes as base64url — 43 characters over a 64-symbol alphabet — so an
 * 8-character run carries ~48 bits and occurs by chance about once in 2.8e14
 * strings. It is not enough to reconstruct the token, and reconstruction is
 * not the threat: the threat is a run long enough to FINGERPRINT this
 * credential across a CI log, a screenshot and a scrollback, or to confirm a
 * guess about it. Eight is deliberately below the shortest quote a runtime is
 * known to produce (V8 cuts its JSON snippet at ten), because the belt must
 * not depend on which runtime does the mangling. It is not lower because a
 * shorter run starts colliding with the base32/base64 material this program
 * legitimately prints — ULIDs, identity keys — and a diagnostic pockmarked
 * with markers is a diagnostic an operator stops reading.
 *
 * HOW IT SURVIVES THE MANGLING, which is where the last belt actually failed:
 * it compared against the raw secret while the text had already been through
 * `sanitizeForTerminal`, so one changed byte was enough to miss. Registration
 * therefore records the secret AND what each sanitizer here would make of it,
 * and every variant is hunted. That is the same trick the old
 * `quotesCredential` learned late — put the needle through the same function
 * as the haystack — applied at registration time so it costs nothing per call.
 * ---------------------------------------------------------------------------
 */
const CREDENTIAL_RUN = 8;

/**
 * Below this a value is not treated as a credential at all. Six characters
 * cannot be told from a coincidence in ordinary transport prose, and a token
 * that short would make this belt eat words out of every diagnostic on the
 * machine — the false-positive direction is not free.
 */
const CREDENTIAL_FLOOR = 6;

/**
 * What replaces it. Names the thing that happened, so an operator reading
 * `answered 500 internal: upstream rejected Bearer [credential withheld]`
 * knows the server quoted their token back at them — which is itself a
 * finding — rather than wondering what the CLI failed to print.
 *
 * A LADDER, NOT A CONSTANT, AND THE REASON IS THAT THE MARKER WAS ITSELF A
 * LEAK. `redactRuns` is forward-only and deliberately never rescans what it
 * has emitted — that is what makes it terminate — so the one string it writes
 * without ever checking is its own marker. For a token beginning with the word
 * `credential`, `[credential withheld]` carries `credenti`, `redentia` and
 * `edential` straight into the output: three eight-character runs of the
 * secret, put there by the redactor. Contrived (the server would have to mint
 * such a token) and fixed anyway, because an invariant with an exception is
 * not an invariant, and the next reader will be told this one holds
 * absolutely.
 *
 * The marker is therefore CHOSEN at redaction time — the first phrase that
 * shares no protected run with any registered needle — rather than fixed at
 * compile time against secrets nobody has seen yet. Every rung is readable
 * prose that names the removal, so an operator loses nothing but the word.
 *
 * NO QUOTE AND NO BACKSLASH in any of them, and the reason is now BELT rather
 * than braces. The structured printers used to redact the SERIALIZED record,
 * where a marker carrying either would have turned a disclosure fix into a
 * parse failure for every `--json` consumer. They redact VALUES now
 * (`redactValues` below, called from output.ts), so the encoder escapes
 * whatever a marker contains and validity no longer depends on this list. The
 * constraint stays because a marker with a quote in it would still be ugly in
 * a terminal and because nothing here needs one.
 */
const CREDENTIAL_MARKS = [
  '[credential withheld]',
  '[secret withheld]',
  '[value withheld]',
  '[withheld]',
];

/**
 * The last resort, and its guarantee is its LENGTH rather than a search.
 *
 * A needle is at least `CREDENTIAL_FLOOR` characters (`guardCredential` drops
 * anything shorter), so the window `findRun` looks for is at least
 * `CREDENTIAL_FLOOR` characters too — and a string shorter than that cannot
 * contain one. Four characters is unconditionally clean against every needle
 * that can ever be registered, including ones that collide with all four
 * phrases above at once.
 *
 * Reached only when a secret contains a run of `credential withheld` AND of
 * `secret withheld` AND of `value withheld` AND of `withheld`. It is terse
 * rather than illegible: an operator still sees that something was cut out at
 * that exact spot, which is the property that matters.
 */
const CREDENTIAL_MARK_LAST = '[--]';

/**
 * The marker in force for the registry as it currently stands.
 *
 * Chosen against EVERY registered needle, not merely the one being replaced,
 * because `redactCredentials` loops needle after needle over the same
 * accumulating string: a marker emitted for needle A is rescanned by needle B,
 * so one that is clean only for its own emitter would be eaten — and mangled
 * — by the next.
 *
 * Cached because this is a hot path (every `sanitizeForTerminal`, which is
 * every line of every message), and the answer can only change when the
 * registry does. `guardCredential` and `forgetCredentials` invalidate it.
 */
let markCache: string | null = null;

export function credentialMark(): string {
  if (markCache !== null) return markCache;
  markCache =
    CREDENTIAL_MARKS.find((candidate) =>
      tracked.every((entry) => entry.needles.every((n) => findRun(candidate, n) === null)),
    ) ?? CREDENTIAL_MARK_LAST;
  return markCache;
}

/**
 * How many credentials are tracked at once. The sources are bounded and small:
 * one per account whose profile this process loads, plus one per renewal. 64
 * is far past any real invocation; the cap exists so a long-lived listener
 * cannot turn a leak-prevention measure into a memory leak. The OLDEST goes
 * first, which is the safe direction — an evicted token is one that has since
 * been replaced, and the live one is always the newest.
 */
const CREDENTIAL_TRACK_MAX = 64;

interface TrackedCredential {
  raw: string;
  /** The secret as itself, and as each sanitizer here would leave it. */
  needles: string[];
}

const tracked: TrackedCredential[] = [];

/**
 * Record a value that must never appear in output.
 *
 * Called wherever a credential ENTERS this process — minted from the server
 * (api.ts `checkedSessionToken`), read off disk (profile.ts `loadProfile`,
 * doctor.ts's hand parse), or simply presented (api.ts `request`, which covers
 * a token acquired by some future route neither of the others knows about).
 * Cheap and idempotent, so a caller in doubt should call it.
 */
export function guardCredential(secret: string | undefined | null): void {
  if (typeof secret !== 'string' || secret.length < CREDENTIAL_FLOOR) return;
  if (tracked.some((t) => t.raw === secret)) return;
  // The needle is mangled the same way the haystack will be. `redactRuns` is
  // called from inside `sanitizeForTerminal`, so the text it sees may already
  // have had its control bytes stripped and (in `sanitizeServerField`) its
  // line breaks flattened; a secret carrying either is only findable if the
  // same transformation was applied to it first.
  const stripped = secret.replace(CONTROL_CHARS, '');
  const flattened = stripped.replace(LINE_BREAK_RUN, ' ');
  const needles = [...new Set([secret, stripped, flattened])].filter(
    (n) => n.length >= CREDENTIAL_FLOOR,
  );
  tracked.push({ raw: secret, needles });
  if (tracked.length > CREDENTIAL_TRACK_MAX) tracked.shift();
  // The marker is a function of the registry, and the registry just changed.
  markCache = null;
}

/** TEST-ONLY: forget everything registered. Nothing in the CLI calls it — a
 * process holds its credentials until it exits — but a test file that runs
 * several fixtures through one module registry needs the state to be its own. */
export function forgetCredentials(): void {
  tracked.length = 0;
  markCache = null;
}

/**
 * The FIRST run of `needle` present in `text`, whole, or null.
 *
 * Windows of exactly `CREDENTIAL_RUN` are searched because any longer run
 * necessarily contains one: the window set is a COMPLETE detector, not a
 * heuristic. The hit is then expanded in both directions so the whole
 * contiguous run disappears rather than the eight characters that found it —
 * otherwise a 43-character token would be replaced by a marker plus 35
 * characters of itself.
 */
function findRun(text: string, needle: string): { start: number; end: number } | null {
  const window = Math.min(CREDENTIAL_RUN, needle.length);
  let at = -1;
  let from = -1;
  for (let i = 0; i + window <= needle.length; i++) {
    const idx = text.indexOf(needle.slice(i, i + window));
    if (idx !== -1 && (at === -1 || idx < at)) {
      at = idx;
      from = i;
    }
  }
  if (at === -1) return null;
  let start = at;
  let left = from;
  while (start > 0 && left > 0 && text[start - 1] === needle[left - 1]) {
    start--;
    left--;
  }
  let end = at + window;
  let right = from + window;
  while (end < text.length && right < needle.length && text[end] === needle[right]) {
    end++;
    right++;
  }
  return { start, end };
}

function redactRuns(text: string, needle: string, mark: string): string {
  let out = '';
  let rest = text;
  // Forward-only: what has already been emitted (including the marker itself)
  // is never rescanned, so this terminates by construction — every turn drops
  // at least one window's worth of `rest`.
  //
  // THAT IS ALSO WHY THE MARKER IS PASSED IN RATHER THAN READ FROM A CONSTANT.
  // "Never rescanned" used to be stated as the reason a pathological marker
  // was harmless; it is the opposite — it is the reason a marker sharing a run
  // with the secret is emitted UNCHECKED. `credentialMark()` picks one that
  // shares no run with any registered needle, so this loop's blindness costs
  // nothing.
  for (;;) {
    const hit = findRun(rest, needle);
    if (hit === null) return out + rest;
    out += rest.slice(0, hit.start) + mark;
    rest = rest.slice(hit.end);
  }
}

/**
 * Remove every run of every registered credential. The chokepoint itself.
 *
 * A no-op — one branch — until something registers a credential, which is what
 * keeps it off the cost of the paths that never hold one.
 */
export function redactCredentials(text: string): string {
  if (tracked.length === 0 || text === '') return text;
  // One marker for the whole pass, chosen against the whole registry — see
  // `credentialMark`. Choosing per needle would let needle B redact the marker
  // needle A had just emitted.
  const mark = credentialMark();
  let out = text;
  for (const entry of tracked) {
    for (const needle of entry.needles) {
      if (out.length < Math.min(CREDENTIAL_RUN, needle.length)) continue;
      out = redactRuns(out, needle, mark);
    }
  }
  return out;
}

/**
 * The same removal, applied to a RECORD before it is serialized — never to the
 * document after.
 *
 * WHY THIS EXISTS AT ALL, because the shape it replaces looked like the same
 * thing and was a second defect. `Reporter.emit` redacted
 * `JSON.stringify(record)`: one string, one pass, and every field covered. But
 * `redactCredentials` removes a run WHEREVER IT OCCURS, and in a serialized
 * document runs occur in places that are not string values —
 *
 *   - inside a NUMBER. A 43-character token opening `12345678` and a server
 *     timestamp of `1234567890123` share that run, so `{"ts":1234567890123}`
 *     came out `{"ts":[credential withheld]90123}`, which no parser accepts.
 *   - across a DELIMITER. `","` and `":"` are ordinary characters to a
 *     substring search, so a needle spanning one takes the punctuation away
 *     with it and the object never closes.
 *
 * BOTH HALVES ARE THE SERVER'S. It mints the token and it sends the
 * timestamps, so a hostile one could make `listen --json`, `gcall` and
 * `calllog` unparseable at will — a denial of the one output shape a script
 * consumes, produced by the code that exists to protect it. Reproduced end to
 * end through the real binary (test/gate.value-redaction.test.ts).
 *
 * Redacting the VALUES cannot do either: the encoder runs last, so a marker
 * lands inside a JSON string or nowhere, and a number is never touched because
 * a number is never a string. The document is valid BY CONSTRUCTION rather
 * than by the marker table happening to contain no quote.
 *
 * WHAT IT WALKS: exactly what `JSON.stringify` serializes. Own enumerable
 * string keys (redacted too — a key can carry a value as easily as a value
 * can, and NON-DESTRUCTIVELY, which `freeKey` below explains and which cost a
 * dropped field before it existed), array elements, and the result of `toJSON`
 * where an object defines one, so a Date or a class instance cannot smuggle a
 * credential past by not being a plain object. A cycle is left alone for
 * `JSON.stringify` to refuse in its own words rather than being turned into a
 * stack overflow here.
 *
 * THE FIELD COUNT IS AN INVARIANT WITH ONE MEASURED EXCEPTION: an object
 * leaves this function with exactly as many own enumerable keys as it arrived
 * with, EXCEPT for an own `__proto__` key, which is lost. A redaction may
 * rename a field; the only field it removes is that one.
 *
 * The exception is not a rounding error in the claim, it is a real dropped
 * field: `redactValue` builds its result with `out[key] = value` on a plain
 * object, and for the key `__proto__` that assignment invokes
 * `Object.prototype`'s legacy prototype setter instead of creating an own
 * property, so nothing is written. Measured, with a credential registered so
 * the walker actually runs: `{"__proto__":1,"keep":2}` goes in with two own
 * keys and comes out with one. `JSON.parse` is the only thing that produces
 * an own `__proto__` here and no record this program composes has one, the
 * field is DROPPED rather than disclosed, and the document still serializes —
 * which is why it was left in place rather than fixed. The full argument is
 * the carried-limit entry for this function in an earlier review
 * log. An invariant with an unstated
 * exception is what the next reader relies on, so it is stated here as well as
 * there.
 *
 * The human path keeps `redactCredentials`: prose is not parsed, so a marker
 * mid-word costs a reader nothing and there is no structure to corrupt.
 */
export function redactValues<T>(value: T): T {
  if (tracked.length === 0) return value;
  return redactValue(value, new Set()) as T;
}

/**
 * A key that is not already taken in `out`, derived from `wanted`.
 *
 * REDACTING A KEY MUST NOT DELETE A FIELD, and before this existed it did.
 * `out[redactCredentials(key)] = …` is an assignment, and two DISTINCT keys can
 * redact to the SAME marker — at which point the second write silently
 * overwrote the first and the record came out of here one field short. The
 * 43-character token `announcedconnected`+25 is enough: `announced` and
 * `connected` both become `[credential withheld]`, and the small-group dump
 * `{live:true,announced:["peer"],connected:false}` was printed as
 * `{"live":true,"[credential withheld]":false}` — reaching `gcall`, which is
 * the command the e2e group-call harness reads to decide whether a session exists. A
 * negative assertion resting on a record with a field missing is not an
 * assertion about that record.
 *
 * WHY NOT SIMPLY STOP REDACTING KEYS. That was the other candidate — leave the
 * key, redact only the value — and it is not safe here: a record may be KEYED
 * by a server-chosen value (mcp.ts serializes arbitrary tool payloads through
 * `redactValues`, and nothing stops a future record from keying a map by
 * userId, which `AuthResponse` permits to equal the bearer). Dropping the key
 * pass would trade a lost field for a disclosed credential, which is the worse
 * of the two.
 *
 * SO: KEEP BOTH, UNDER DISTINGUISHABLE NAMES. The disambiguator is checked
 * against `out` AS IT STANDS, so it is decided against every key already
 * placed — including earlier disambiguated ones and any literal collision the
 * source object happened to contain. Nothing can be overwritten, so no field
 * is lost TO A COLLISION — which is this function's whole subject, and is not
 * the same as "the output has exactly as many fields as the input, always",
 * which is what this sentence used to say. One key is still lost, and not
 * here: an own `__proto__` never becomes an own property of `out` at all,
 * because the assignment hits `Object.prototype`'s prototype setter. The suffix is `#2`, `#3`, …
 * because it reads as an ordinal rather than as part of the marker's prose, and
 * an operator seeing `[credential withheld]#2` can tell that a SECOND distinct
 * key was cut out at that spot rather than the same one twice.
 *
 * The original key name is gone, and that is the point of redacting it: the
 * name carried the credential. What is preserved is the FIELD — its value, and
 * the fact that there was one.
 */
function freeKey(out: Record<string, unknown>, wanted: string): string {
  if (!Object.hasOwn(out, wanted)) return wanted;
  for (let n = 2; ; n++) {
    const candidate = `${wanted}#${n}`;
    if (!Object.hasOwn(out, candidate)) return candidate;
  }
}

function redactValue(value: unknown, seen: Set<object>): unknown {
  if (typeof value === 'string') return redactCredentials(value);
  if (value === null || typeof value !== 'object') return value;
  const obj = value as { toJSON?: unknown };
  // A cycle: `JSON.stringify` is about to throw its own TypeError about it,
  // and that diagnosis is better than a RangeError from this recursion.
  if (seen.has(obj)) return value;
  if (typeof obj.toJSON === 'function') {
    return redactValue((obj.toJSON as () => unknown).call(obj), seen);
  }
  seen.add(obj);
  try {
    if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen));
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[freeKey(out, redactCredentials(key))] = redactValue(entry, seen);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Terminal controls out, and every registered credential
 * with them. See THE CREDENTIAL CHOKEPOINT above for why the redaction lives
 * inside this function rather than beside the sinks that leaked: this is the
 * one call every peer- and server-influenced string in the package already
 * makes on its way to a stream.
 */
export function sanitizeForTerminal(text: string): string {
  return redactCredentials(text.replace(CONTROL_CHARS, ''));
}

/**
 * A field the SERVER chose, on its way to a terminal — stripped AND bounded.
 *
 * The decrypted body is the part an attacker most obviously controls, and it
 * is the part this module was written for. It is not the only part. In
 * packages/shared/src/frames.ts, `MsgFrame.from` and `ErrorFrame.code`/
 * `.detail` are plain `z.string()` — note that the `Ulid` regex IS applied to
 * `msgId` in the same object but not to `from` — and they are printed on the
 * same stdout line, immediately beside the body a script is parsing. This
 * product treats the server as untrusted for content, so a hostile or merely
 * buggy one must not be able to inject ESC bytes there, or a megabyte.
 *
 * `JSON.stringify` is not a substitute under `--json`: it escapes C0, but DEL
 * and C1 (7F-9F) pass through a JSON string intact.
 */
export function sanitizeServerField(value: string, max = 64): string {
  // Newlines go too, which is the difference between this and a message body
  //. `sanitizeForTerminal` deliberately keeps LF —
  // a body is prose and may have lines — but a server FIELD is one field on
  // one line, and leaving LF in let a hostile server forge a second
  // `error: ...` line on stderr under the CLI's own prefix.
  //
  // EVERY break, not `[\r\n]`, and an earlier revision is why the difference matters. A
  // field like this one is the PREFIX of a line: `[<from>] ` leads the chat
  // print, `server error: <code>: ` leads the failure print. `prefixLines`
  // can give every line of a BODY an owner, but nothing can rescue a prefix
  // that ends itself — so the id `01X<LS>CALL busy<PS>Y` rendered as three
  // Unicode lines, the middle one exactly `CALL busy` at column zero, and the
  // July remedy walked straight past it because U+2028 is not `\r` or `\n`.
  // Flattened to a space rather than dropped: a field is one field on one
  // line, and the words on either side of the break were both really there.
  //
  // REDACTED TWICE, and the second one is not decoration. `sanitizeForTerminal`
  // has already removed every registered credential from `value`; the flatten
  // on this line can CREATE a match that was not there before, because it is a
  // transformation of the haystack that the needle set also anticipates (a
  // token whose stored form carried a line break arrives here as two words and
  // leaves as one). Redacting after the flatten is what makes the belt hold
  // for the shape that actually leaked in July.
  //
  // BEFORE THE TRUNCATION, so the bound can only ever cut the marker's own
  // prose. Truncating first and redacting second would leave a run that had
  // already been printed.
  const clean = redactCredentials(sanitizeForTerminal(value).replace(LINE_BREAK_RUN, ' '));
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Give EVERY line of a rendered message the sender's own prefix.
 *
 * A LINE THAT BEGINS WITH ONE OF THIS PROGRAM'S MACHINE PREFIXES MUST BE THIS
 * PROGRAM'S OWN WORD, AND A REMOTE PEER'S MESSAGE MAY NOT IMPERSONATE IT.
 *
 * `rendered.text` is the peer's decrypted plaintext, and `sanitizeForTerminal`
 * deliberately keeps LF — a multi-line message is a feature, not an attack.
 * Printed under a single leading `[peer] `, the body
 * `hello\nGCALL leg_dial to=… cid=… kind=ginvite` therefore put a second line
 * on this client's stdout that was byte-identical to one the call runner emits
 * itself. The e2e gate's provenance scanner anchors on `^GCALL `: a peer who
 * can write that line sanctions a cid of their own choosing, after which a
 * real `call.end` on that cid reads as legitimate traffic. Reproduced — the
 * scan returned rc=0 with no findings.
 *
 * The gate is only the loudest consumer of this stream. A log shipper, and an
 * operator grepping it during an incident, are owed the same guarantee, and it
 * is the CLI that owes it: a consumer cannot tell a forged line from ours after
 * the fact, because the bytes are the same bytes.
 *
 * NOT a flattener, an escaper or a truncator. Every line of the message is
 * still printed, in order, in full; what changes is that none of them can be
 * read as ours, because the forged `GCALL …` arrives as `[01ABC…] GCALL …` and
 * no longer matches a `^GCALL ` anchor.
 *
 * THE ONE IMPLEMENTATION, and it lives HERE rather than beside a caller for
 * the reason an earlier revision exists. An earlier revision wrote this rule as a private function
 * inside call-session.ts, so it protected `listen --calls` and nothing else:
 * plain `listen` (inbound.ts — the chat line, the carrier note, and the
 * quarantine fallback that is the LAST copy of a plaintext) and `inbox`
 * (main.ts — where `--peek` reprints the same forged line on every later run)
 * kept interpolating `[${shownFrom}] ${text}` raw, on the paths that carry
 * more traffic than the call session does. A rule with three call sites and a
 * fourth unprotected one is not a rule. Every surface that prints peer- or
 * server-influenced text calls this; nothing reimplements it.
 *
 * WHAT COUNTS AS A LINE IS `LINE_BREAK`, and it is deliberately wider than the
 * two characters a terminal cares about — see that constant for who is owed
 * which break. An earlier revision wrote this rule with `/\r\n|[\n\r]/` and its own
 * regression test split the captured output on `'\n'`, so the two agreed with
 * each other and neither could see U+2028: the body `hello<LS>GCALL leg_dial …`
 * still produced an unprefixed machine line for every Unicode-aware reader,
 * and the test stayed green over the hole for a full round.
 *
 * NORMALIZED TO LF on the way out, which is the one thing here that changes a
 * byte of the message. It is the same normalization an earlier revision already applied
 * to CR, and it is the point rather than a side effect: after this, every
 * consumer of the stream agrees on where the lines are, instead of a terminal
 * seeing one line where a log processor sees two.
 *
 * THE PREFIX IS FLATTENED, not split. `sanitizeServerField` is the real remedy
 * for a hostile `from` and it is applied at every call site — but a helper
 * whose guarantee holds only when its caller sanitized first is a helper that
 * will be called wrongly exactly once, and the failure is silent when it
 * happens (an earlier review: the body was owned line by line and the label
 * beside it was not).
 */
export function prefixLines(prefix: string, text: string): string {
  const own = prefix.replace(LINE_BREAK_RUN, ' ');
  return text
    .split(LINE_BREAK)
    .map(line => `${own}${line}`)
    .join('\n');
}

function str(value: unknown, max = 80): string {
  return typeof value === 'string' ? sanitizeForTerminal(value).slice(0, max) : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function renderBody(
  body: string,
  renderGroup?: GroupBodyRenderer,
  names?: MentionNames,
): RenderedBody {
  if (!body.startsWith(ENVELOPE_SENTINEL)) {
    return { tcm: '', carrier: false, text: sanitizeForTerminal(body) };
  }

  const declared = DECLARED_TCM.exec(body)?.[1] ?? '';

  // Routed on the NAMESPACE, before parsing, so signalling stays silent even
  // in a shape this build has never seen. `cli listen --calls` handles these
  // properly; plain `cli listen` must not spray them at the terminal.
  if (declared.startsWith(CALL_NAMESPACE)) {
    return { tcm: declared, carrier: true, text: '' };
  }

  // The reserved machine namespace prints NOTHING AT ALL, on either stream,
  // parseable or not. Before parse, deliberately: a carrier decided
  // after parsing is a carrier that turns noisy the day the shape changes.
  if (declared.startsWith(EXTENSION_NAMESPACE)) {
    return { tcm: declared, carrier: true, text: '' };
  }

  // Room bodies go to the injected renderer, which owns the store context and
  // recurses back into this switch for the inner content. A surface
  // that injected none still NEVER prints the raw envelope: the room kinds
  // are conversational, so they degrade to the same visible unsupported line
  // an unknown kind gets — a human is told something arrived, and no JSON,
  // no member id and no room id reaches the terminal.
  if (declared.startsWith(GROUP_NAMESPACE)) {
    if (renderGroup) return renderGroup(declared, body);
    return { tcm: declared, carrier: false, text: `[${UNSUPPORTED_TEXT}]` };
  }

  let env: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object') env = parsed as Record<string, unknown>;
  } catch {
    env = null;
  }
  if (!env) return { tcm: declared, carrier: false, text: `[${UNSUPPORTED_TEXT}]` };

  switch (declared) {
    // --- conversation: a row on the phone, so a line of stdout here ---

    case 'reply': {
      // A reply IS its text; what it answers is thread context the CLI could
      // not show — until the ledger existed. The ref now SURVIVES: it is the msgId the phone is answering, the exact key
      // the notify path minted and recorded, and dropping it here was one of
      // the two seams where reply routing died. Shape-checked to the msgId
      // grammar, not trusted: a hostile ref routes nowhere.
      const text = str(env.text, 4096);
      const rawRef = typeof env.ref === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}(\.[0-9A-HJKMNP-TV-Z]{26})?$/.test(env.ref) ? env.ref : undefined;
      const ofs = env.ofs === true ? true : undefined;
      return text
        ? { tcm: declared, carrier: false, text, ...(rawRef ? { ref: rawRef } : {}), ...(ofs ? { ofs } : {}) }
        : { tcm: declared, carrier: false, text: `[${UNSUPPORTED_TEXT}]` };
    }
    case 'mention': {
      // A mention IS its words, with each U+FFFC mark resolved to THIS
      // client's name for the Nth id in `who`: `@you` for the local account
      // (the whole point of the feature — the mentioned person must see it),
      // `@<stored name>` for a peer this client has named, `@someone` for
      // one it has not. NEVER the raw ULID: an id means nothing to a human,
      // and a terminal scraped by CI is a surface with a long memory.
      //
      // Parse-permissive (the house rule): compose refuses a mark/id
      // mismatch, but this side renders what it can and drops what it
      // cannot — a mark past the last id renders as nothing, ids past the
      // last mark are simply never printed, and a non-string id drops its
      // mark rather than inventing a person.
      const text = str(env.text, 4096);
      if (!text) return { tcm: declared, carrier: false, text: `[${UNSUPPORTED_TEXT}]` };
      const who: readonly unknown[] = Array.isArray(env.who) ? env.who : [];
      // The mentions-self flag: read off the STRUCTURED who[] —
      // the whole array, because the envelope's claim is "these people are
      // named", not "these marks resolved" — and never off the text. No
      // injected resolution means no self to match: fails closed.
      const men =
        names !== undefined && who.some(id => typeof id === 'string' && id === names.selfId);
      let nth = 0;
      const resolved = text.replace(MENTION_MARKS, () => {
        const id = who[nth];
        nth += 1;
        if (typeof id !== 'string' || id === '') return '';
        if (names && id === names.selfId) return '@you';
        // Stripped and bounded AGAIN at display, even though profile
        // recording already sanitized: the names file is hand-editable, and
        // a file is an input too (the peer-names precedent in stores.ts).
        const stored = names?.nameFor(id);
        const clean =
          stored === undefined
            ? ''
            : sanitizeForTerminal(stored).slice(0, MENTION_NAME_MAX).trim();
        return clean === '' ? '@someone' : `@${clean}`;
      });
      // Words that were only marks with nothing to resolve: visible notice,
      // never silence — a human is told something arrived — and never JSON.
      return resolved.trim() === ''
        ? { tcm: declared, carrier: false, text: `[${UNSUPPORTED_TEXT}]` }
        : { tcm: declared, carrier: false, text: resolved, ...(men ? { men: true } : {}) };
    }
    case 'msg': {
      // Marked bare text (@tacendum/shared ai-origin.ts): an agent's
      // ordinary words wearing the Art. 50 wrapper. The words ARE the
      // message — rendered exactly as bare text would be, sanitized and
      // bounded like the reply arm's. The marker itself needs no terminal
      // ornament: the CLI's peers here are the agent's own owner and
      // crew-mates, and the badge surface is the phone's.
      const text = str(env.text, 4096);
      return text
        ? { tcm: declared, carrier: false, text }
        : { tcm: declared, carrier: false, text: `[${UNSUPPORTED_TEXT}]` };
    }
    case 'image': {
      // The blob id and its AES key are NOT printed. They are a read
      // capability for the attachment store; a CI log is not where they go.
      const w = num(env.w);
      const h = num(env.h);
      return {
        tcm: declared,
        carrier: false,
        text: w && h ? `[photo ${w}x${h}]` : '[photo]',
      };
    }
    case 'file': {
      // Same withholding as 'image': att and key never reach a terminal.
      // The name and size are the peer's claims — sanitized and bounded like
      // every other peer-controlled string. Saving the actual bytes is the
      // inbound policy's job (`--save-dir`), not the renderer's.
      const fname = str(env.name, 200);
      const size = num(env.size);
      return {
        tcm: declared,
        carrier: false,
        text:
          fname && size !== null
            ? `[file ${fname} (${size} bytes)]`
            : fname
              ? `[file ${fname}]`
              : '[file]',
      };
    }
    case 'shot':
      return { tcm: declared, carrier: false, text: '[screenshot]' };
    case 'timer': {
      const s = num(env.s) ?? 0;
      return {
        tcm: declared,
        carrier: false,
        text: s > 0 ? `[disappearing messages on (${s}s)]` : '[disappearing messages off]',
      };
    }
    case 'vault':
      // TITLE AND BODY ARE BOTH WITHHELD, and that is not caution for its own
      // sake. A vault item is a door code, a Wi-Fi password, a case reference.
      // The app already keeps the title out of previews because "Divorce
      // lawyer login" is itself the disclosure; a terminal that is being
      // scraped by CI is a preview surface with a longer memory than any
      // notification. The announcement is the whole message.
      return {
        tcm: declared,
        carrier: false,
        text: env.op === 'del' ? '[vault item removed]' : '[vault item saved]',
      };

    // --- carriers: they rewrite state, they are not something anyone said ---

    case 'react': {
      const emoji = str(env.emoji, 16);
      return {
        tcm: declared,
        carrier: true,
        text: emoji ? `reaction ${emoji}` : 'reaction cleared',
      };
    }
    case 'profile': {
      const name = str(env.n, 40);
      // The name matters operationally — it is how the named-sender pairing
      // flow is confirmed — so it is surfaced, on stderr, where it cannot
      // disturb a stdout stream a script is parsing.
      return {
        tcm: declared,
        carrier: true,
        text: name ? `profile card: "${name}"` : 'profile card (no name)',
        ...(name ? { peerName: name } : {}),
      };
    }
    case 'edit':
      return { tcm: declared, carrier: true, text: 'a message was edited' };
    case 'del':
      return { tcm: declared, carrier: true, text: 'a message was deleted' };
    case 'read': {
      const ids = Array.isArray(env.ids) ? env.ids.length : 0;
      return { tcm: declared, carrier: true, text: `read receipt (${ids})` };
    }

    default:
      // Structure this build has never seen and cannot classify as transport.
      // Visible, because dropping it would hide that anything was sent; a
      // notice, because raw JSON is the defect this module exists to fix.
      return { tcm: declared, carrier: false, text: `[${UNSUPPORTED_TEXT}]` };
  }
}

/**
 * May this decrypted body be written to the plaintext spool?
 *
 * Plain text and replies only. A carrier — a profile card, a reaction, a read
 * receipt — changes state somewhere; it is not something a person said, and
 * the spool is the one place in this product where plaintext outlives the
 * process. `listen --calls` had its own, looser rule (everything that was not
 * `call.*`), so a peer's display name and their reactions were persisted by
 * one listener and not the other; a review caught the divergence.
 */
export function maySpool(rendered: RenderedBody): boolean {
  if (rendered.carrier || rendered.text === '') return false;
  // A mention is conversation exactly as a reply is: it is something a
  // person SAID — pointedly, at this account — and what spools is the
  // resolved rendering (`@you`, this client's own names), never the ids.
  // A `msg` is conversation too: marked bare text, and what spools
  // is the words — the wrapper never reaches the spool.
  if (
    rendered.tcm === '' ||
    rendered.tcm === 'reply' ||
    rendered.tcm === 'mention' ||
    rendered.tcm === 'msg'
  ) {
    return true;
  }
  // A room message wrapping conversational text is conversational text: the
  // same rule, applied to the unwrapped kind. Everything else a room
  // carries — announcements, roster events, and every `grp.hist` transcript
  // entry — stays off the spool: a relayed entry is an UNAUTHENTICATED claim
  // about a third party's words, and the spool has
  // no provenance column, so persisting one would store the claim shorn of
  // the one fact that keeps it honest.
  return (
    rendered.tcm === 'grp.msg' &&
    (rendered.innerTcm === '' || rendered.innerTcm === 'reply' || rendered.innerTcm === 'mention')
  );
}
