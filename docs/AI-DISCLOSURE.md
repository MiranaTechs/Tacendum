# AI disclosure — what the operator is told, where, and the Article 50 position

**What this document is.** The canonical data-flow sentence, the facts the
copy may state, the Article 50 position, and where each piece of text
belongs. It asserts positions and wording, **not compliance** — "this makes
us compliant" is a conclusion this repo does not draw about law, the same
way its threat models list losses next to wins. Anything unresolved is in §6
as an open question, not rounded up.

**Why.** Two obligations attach to the shipped surface, not to future work:
EU AI Act **Article 50**, in force 2026-08-02 (Commission guidelines
2026-07-20) — users must be informed they are interacting with AI unless it
is obvious from context, and generative output carries machine-readable
AI-origin marking; and Apple App Review **5.1.2(i)** (guideline update
2026-06-08) — clearly disclose when personal data is shared with third
parties *including third-party AI*, with permission first.

---

## 1. The canonical sentence

> **"Replies you send are delivered to the AI provider running on your own
> machine; Tacendum's servers relay ciphertext only."**

This file is the sentence's single home. Every other surface that needs it —
the App Store privacy answer, onboarding copy, the threat-model page — quotes
it **verbatim**. No paraphrase, no per-surface variant: a family of
almost-identical sentences is how a claim drifts until one of its copies is
false.

## 2. What is actually true of the current build

The copy may state these, and only these, because each was read in the tree
rather than assumed:

- **An agent is a separate account with its own keypair.** `tacendum register
  <name> --integration` creates an integration-class account; the server
  honours the class **only at creation**, so a returning sign-in cannot
  promote or demote one. Its identity is a keypair like any account's — not
  a flag on the human's account.
- **Adopted by one human, and bound server-side.** The owner binding is
  write-once; an unbound integration cannot send at all
  (`packages/server/src/handlers/ws.ts`, 403 `integration_unbound`), and a
  bound one reaches its owner, a fellow same-crew integration, or a human
  who personally consented to it: a non-owner human is reachable **iff that
  human wrote a server-stored consent edge to this agent** (`POST
  /v1/consent`, checked by `consentAdmits` at the send, inbox and typing
  arms; 403 `integration_recipient_forbidden` otherwise), and deleting the
  edge refuses the next frame in either direction. The agent appears under
  the name its human gave it: the registration name is operator-chosen, and
  labels are locally authored.
- **The operator's own machine runs the agent, through the vendor's own
  client.** attend resolves the `claude` or `codex` binary from the
  operator's own PATH (`packages/cli/src/attend.ts`, `/usr/bin/which` at
  enable time) and spawns it under the sign-in the operator performed,
  defaulting to the constrained profiles (codex `-s read-only`, claude
  `--permission-mode plan`). Tacendum operates no model, holds no vendor
  credential, and proxies no inference call. What the copy may say about
  that sign-in is fixed by §2.1.
- **The relay carries ciphertext and routing metadata, never plaintext.**
  Queued message ciphertext is stored up to 30 days (`MESSAGE_TTL_SECONDS`,
  `packages/server/src/handlers/ws.ts`); what the server learns is routing
  metadata — who sent to whom, when, and how large the ciphertext was — and
  that is stated as collection, not excused by the encryption (E2EE is a
  protection, not an exemption from disclosure).
- **Replies are throttled, and host diagnostics never reach the phone.**
  Everything attend sends crosses one 280-char funnel (`capChatHead`,
  `packages/cli/src/hooks.ts`, applied in `attend.ts`), and host stderr is
  never repeated back — a live API key once reached an operator's phone
  inside a helpful diagnostic, and the rule in `attend.ts` is that
  incident's record.

What the copy may **not** say: anything about what the agent's shell can or
cannot reach (§5), "provably never receives" for any delivery-path property
that has no design yet, or any claim about the AI provider's own retention
or training — once plaintext reaches the model, that side of the flow is
governed by the operator's own vendor agreement.

### 2.1 Vendor sign-in — the ToS position (verified 2026-08-12, primary sources)

This section carries the position for copy, checked against the vendors'
published terms as retrieved on the date above. **The forbidden phrase
first: do not write "runs on your existing subscription" for Claude.** It is
wrong for one supported configuration and gray for the other — the thing
Anthropic permits is ordinary use of Claude Code under the operator's own
plan, which is narrower than that promise.

- **Anthropic** (code.claude.com "Legal and compliance", retrieved
  2026-08-12): OAuth subscription sign-in "is intended exclusively for
  purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription
  plans and is designed to support ordinary use of Claude Code and other
  native Anthropic applications"; Anthropic "does not permit third-party
  developers to offer Claude.ai login or to route requests through Free,
  Pro, or Max plan credentials on behalf of their users", and directs
  products built on the Agent SDK to API-key authentication. Anthropic's own
  docs bless scripted use *of Claude Code itself* (`claude setup-token`,
  "for CI pipelines and scripts"), and its advertised plan limits "assume
  ordinary, individual usage of Claude Code and the Agent SDK".
- **OpenAI** is permissive by contrast: "Sign in with ChatGPT" is offered as
  a feature of third-party integrations, account-auth automation is
  documented as supported on trusted private machines, and API keys are the
  *recommended* default for automation. Binding constraints: no credential
  sharing, no circumventing rate limits, not on public or shared
  infrastructure.
- **The architecture position this produces:** the bridge drives *the
  operator's own installation of the vendor's own client*, signed in by the
  operator. For Claude, two modes — the default spawns the genuine Claude
  Code CLI under the operator's own login (subscription-safe); an opt-in
  Agent SDK mode requires an operator-supplied Claude Console **API key**
  and is refused on subscription credentials. Stated consequence, carried
  into copy honestly: approvals are available for Codex under either auth,
  and for Claude only under API-key auth.

Wording the copy may adapt (meaning fixed, phrasing per surface):

> Claude: "The bridge drives your own installation of Anthropic's Claude
> Code, which you sign in to yourself. Anthropic permits subscription
> sign-in only inside Claude Code and its other native applications; usage
> counts against your plan's 5-hour and weekly limits. You may instead
> supply a Claude Console API key, which is what Anthropic directs
> developers and heavy automation to use."

> Codex: "The bridge drives the Codex CLI, and you sign in with your own
> ChatGPT account using Codex's official login (device-code supported for
> headless machines). OpenAI recommends an API key for unattended
> automation, which the bridge also supports."

**UNVERIFIED — do not assert:** the exact API-layer error string Anthropic
returns for out-of-product OAuth use, and the reported April 2026
third-party-harness cutoff date. Both are secondary-source only.

## 3. The Article 50 position (a position, not an implementation)

Article 50 asks two things of this surface.

**Interaction disclosure.** The agent is a distinct account class the human
adopted, named, and pairs with deliberately; every message from it is
attributed to that distinct identity. Whether that makes the AI nature
"obvious from context" (the Article's exemption) is deliberately **not
resolved here** (§6) — the position is to disclose anyway: onboarding
carries the §1 sentence and says plainly that the thing being adopted is an
AI agent, and agent-authored messages carry a visible AI badge — an
agent-authored row renders `AGENT_COPY.badge` with a spoken clause for
VoiceOver (`app/src/screens/ChatThreadScreen.tsx`, `app/src/machine.ts`).

**Machine-readable AI-origin marking.** The design intent, fixed here so the
implementation cannot drift: the marker rides **inside the E2EE envelope**
(a `tcm`/`x.*` structured field on agent-authored messages), so it is signed
with the agent's own identity — **unforgeable by the relay and invisible to
it**. The server never sees the label, cannot strip it, and cannot add it;
recipients verify it the same way they verify the sender.

This marker ships in the current build: `ai: true` rides the envelope kinds
(`packages/shared/src/ai-origin.ts`), every agent-authored body leaves
through one funnel (`packages/cli/src/ai-origin.ts`, `markAgentBody`),
arrival records it on the message row, and the badge derives
marker-OR-record. Bare text is still wrapped only under the operator's own
app-build attestation (`attend enable --marker`) — a condition about the
operator's own device, not about the marker's existence.

## 4. Where each piece of text belongs

| Surface | What it carries |
|---|---|
| **App Store privacy answer** (App Store Connect → App Privacy) | The §1 sentence, quoted, as the basis for the third-party-AI disclosure 5.1.2(i) demands; the §2 metadata facts, consistent with the privacy answers' existing "E2EE is a protection, not an exemption" stance. |
| **Onboarding copy** (the adopt flow — PeerProfileScreen "Machines" — and `attend enable` output) | The §1 sentence, quoted, shown **before the first reply can reach an agent** — disclosure after the fact is not "permission first". Plain statement that the adopted account is an AI agent. Teaching detail behind ⓘ, per the house pattern. |
| **The room consent flow** (GroupProfileScreen "Sharing with agents") | The §1 sentence, quoted, above the Share action. This table's rows above it assume the human who discloses is the one who **adopted** the agent; a non-owner never adopts, so their permission-first moment is not adoption but the moment they choose to let someone else's agent hear them (`POST /v1/consent`, §2). Same placement rule: before the choice, not beside its outcome. The provider-side limit (§5) goes behind that section's ⓘ — this screen may not characterize a vendor agreement that is not even the viewer's own. |
| **Security/threat-model page** (README.md's threat-model section) | The §1 sentence, quoted, beside the honest limits of §5 — what the relay sees, what disclosure does not buy, what the in-envelope marker does and does not prove. |

## 5. Honest limits

Stated plainly, because a disclosure doc that only lists wins is marketing.

- **Disclosure buys an informed operator, not a safe agent.** Telling a human
  their counterpart is an AI constrains nothing the AI does. The sentence in
  §1 is a data-flow fact, not a safety property.
- **E2EE says nothing about what the agent's own shell can reach.** The
  Tacendum channel is end-to-end encrypted; the agent runs on a machine with
  the operator's files, environment, and network. Read-only is not no
  egress: tool output reaches the model host and every other tool the agent
  holds, and Tacendum constrains none of them. The boundary is the host, not
  this app.
- **The relay sees metadata.** Who messages whom, when, how often, and how
  large the ciphertext is. A room's fan-out shape is visible. Saying
  "ciphertext only" without saying this would be the overclaim this repo's
  own privacy answers already refuse to make.
- **The in-envelope marker is verifiable only by participants.** That is the
  point — the relay cannot forge it — but the mirror is that no server-side
  proof of labeling can ever be offered, and a malicious *client* omitting
  the marker is constrained by nothing but the server-enforced account class
  it sends under.
- **The provider side of the flow is the operator's contract, not ours.**
  Once plaintext reaches the model on the operator's machine, retention and
  training are governed by the operator's own vendor agreement. We do not
  see it and must not characterize it.
- **Vendor terms move without notice.** Anthropic's wording on
  out-of-product authentication demonstrably shifted twice between 2025 and
  2026, and it reserves the right to enforce "without prior notice". §2.1
  is a position **as of 2026-08-12**, and it must be re-checked before each
  release that repeats it — a disclosure doc quoting last quarter's terms is
  the same defect as a plan citing last month's line numbers.

## 6. Open questions — deliberately left open

1. **Does Article 50's "obvious from the circumstances" exemption apply** to
   an agent the human personally adopted and named? Unresolved; the position
   discloses regardless, so nothing hangs on the answer — but the answer
   would change how much copy is legally load-bearing versus voluntary.
2. **Whether 5.1.2(i)'s "permission first" is satisfied** by adoption plus an
   explicit reply as affirmative acts, or requires a discrete consent screen
   at adopt time. The onboarding placement in §4 works for either; the
   ruling is Apple's, not this document's.
3. **The Anthropic sales-approval route is unexplored.** Anthropic's docs
   invite contacting sales for approval of other authentication
   configurations — the one route that could convert the
   Agent-SDK-on-subscription case from forbidden to permitted. Until someone
   pursues it, the §2.1 two-mode position stands and the copy stays on its
   safe side.
