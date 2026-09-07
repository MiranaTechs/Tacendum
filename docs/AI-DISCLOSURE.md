# AI disclosure

This document records Tacendum's current AI data-flow disclosure, the facts it
supports, and the project's legal position. It does not claim legal
compliance.

The relevant sources are [EU AI Act Article
50](https://eur-lex.europa.eu/eli/reg/2024/1689) and [Apple App Review
Guideline 5.1.2(i)](https://developer.apple.com/app-store/review/guidelines/).
Article 50 applies from 2026-08-02 and requires notice when a person interacts
with AI unless that fact is obvious from context, plus machine-readable
marking of generative output. Guideline 5.1.2(i) requires clear disclosure and
permission before personal data is shared with a third party, including
third-party AI.

## 1. The canonical sentence for machine-hosted agent chat

> **"Replies you send are delivered to the AI provider through a client running
> on your machine; Tacendum's servers relay message ciphertext, not plaintext."**

This is the single canonical data-flow sentence. Every surface that uses it
must quote it verbatim. The provider client runs locally; model processing may
occur on provider systems. “Message ciphertext, not plaintext” describes
message content, not an absence of metadata: Tacendum's service also processes
the routing metadata listed in §2.

## 2. Current data flow and authorization

- **An agent is a separate account with its own keypair.** `tacendum register
  <name> --integration` creates an integration-class account. The class is
  fixed at creation and cannot be changed by a returning sign-in. The
  operator chooses the registration name, and labels are authored locally.
- **One human adopts the agent.** The owner binding is write-once. An unbound
  integration cannot send (`packages/server/src/handlers/ws.ts`, 403
  `integration_unbound`). A bound integration can reach its owner, another
  integration in the same crew, or a human who personally created a
  server-stored consent edge for that agent. `consentAdmits` checks the edge
  during send, inbox, and typing actions; otherwise the server returns 403
  `integration_recipient_forbidden`. Deleting the edge blocks the next frame
  in either direction.
- **The operator's machine runs the agent through the vendor's client.**
  `attend` resolves the `claude` or `codex` binary from the operator's `PATH`
  and launches it under the operator's sign-in. Its default profiles are
  Codex `-s read-only` and Claude `--permission-mode plan`. In this machine-hosted
  agent path, Tacendum operates no model, stores no vendor credential, and
  proxies no inference request. The optional on-device writing assistant has
  a separate data flow, described in §2.2.
- **The service relays ciphertext and routing metadata.** Queued ciphertext is
  retained for up to 30 days (`MESSAGE_TTL_SECONDS`). The service can observe
  sender, recipient, time, and ciphertext size. End-to-end encryption protects
  content; it does not remove the need to disclose metadata collection.
- **Agent replies pass through one 2,000-character limit.** `attend.ts` applies
  `capChatHead` with `ATTEND_REPLY_CAP=2000`. Hook notifications use the
  separate 280-character `HOOK_CHAT_CAP`. Host diagnostic output and stderr
  are not sent to the phone.

These facts do not establish what the agent's shell can access, guarantee a
delivery-path property that is not implemented, or describe a provider's own
retention and training practices. After plaintext reaches the provider through
the client on the operator's machine, the provider side is governed by the
operator's vendor agreement.

### 2.1 Vendor sign-in position

This section reflects the vendors' published terms as of 2026-08-12.

- **Anthropic.** [Claude Code's legal and compliance
  documentation](https://code.claude.com/docs/en/legal-and-compliance) states
  that subscription OAuth is for Claude Code and other native Anthropic
  applications under the operator's plan. It directs Agent SDK products to
  API-key authentication and prohibits third-party products from offering
  Claude.ai login or routing Free, Pro, or Max credentials for users.
- **OpenAI.** [Codex authentication
  documentation](https://developers.openai.com/codex/auth/) supports ChatGPT
  or API-key sign-in, including device-code authentication for headless use.
  It recommends API keys for programmatic CLI workflows and says not to expose
  Codex execution in untrusted or public environments.

Tacendum launches the operator's installed vendor client under the operator's
sign-in. For Claude, the default launches the Claude Code CLI; the optional
Agent SDK mode requires an operator-supplied Claude Console API key and refuses
subscription credentials. Interactive approvals are available for Codex with
account or API-key authentication, and for Claude with API-key authentication.

Copy may describe those modes but must not characterize provider retention,
training, or terms beyond the operator's applicable agreement. Vendor terms
can change; the statements above are dated rather than permanent assurances.

### 2.2 Optional writing assistant (2026-09-07)

The writing assistant has a separate, direct data flow. A person may save an
OpenAI or Anthropic API key in the phone's protected native store. ChatGPT and
Claude subscriptions do not cover API billing. Setup states this before saving.

Opening Improve reads connection metadata but does not generate. Choosing
Improve, Shorter, Warmer or Translate sends the unsent draft directly over
HTTPS to the selected provider, named in the panel. Only transformation
instructions and the draft are included. Picked mentions are replaced by
opaque tokens; IDs and picked display names stay local. Other personal
information typed into the draft still reaches the provider. No chat history,
reply quote, recipient/account/room ID or attachment metadata is included.

OpenAI receives a Responses request with `store:false`; Anthropic receives a
Messages request. Neither includes tools or a conversation continuation. This
is not a zero-retention claim. Processing, retention and billing follow the
person's provider agreement; Tacendum cannot delete a request already received
by the provider. Consumer sign-in is not used to authorize these API requests.

The result stays in memory until Use text adopts it into the ordinary local
draft. It is not a chat message, agent reply or recipient notification. Send
remains separate, after human review. Undo restores the original only while
the adopted draft is unchanged. The integration-account origin marker below
continues to identify agent messages; it is not attached to reviewed human
drafts merely because their author used a writing aid.

Provider keys never enter the Tacendum relay, database, sync, notifications or
diagnostics. Native records are account-bound and cleared on disconnect,
successful real account deletion and initial installation cleanup. Lock,
duress and background transitions revoke access and retire results. Saved
means saved: the UI does not claim a key is verified before a successful
request. Implementation: `app/src/aiWritingService.ts`,
`app/src/aiWritingDraft.ts`, and the composer integration.

## 3. Article 50 position and AI-origin marker

### Interaction disclosure

An agent is a distinct account that the human adopts, names, and pairs with.
Its messages are attributed to that identity. This document does not resolve
whether that makes the AI interaction "obvious from the circumstances" under
Article 50. Tacendum discloses the interaction regardless: onboarding uses the
canonical sentence and identifies the account as an AI agent. Agent-authored
messages display `AGENT_COPY.badge` and include a spoken VoiceOver clause
(`app/src/screens/ChatThreadScreen.tsx`, `app/src/machine.ts`).

### Machine-readable origin

The AI-origin marker travels inside the end-to-end encrypted envelope as a
structured `tcm`/`x.*` field on agent-authored messages. It is signed with the
agent's identity, so the relay cannot read, remove, or add it; recipients
verify it with the sender identity.

The marker is implemented in the current build. `ai: true` is carried by the
envelope kinds in `packages/shared/src/ai-origin.ts`; every agent-authored body
passes through `markAgentBody` in `packages/cli/src/ai-origin.ts`; arrival
records the value on the message row; and the badge uses the marker or stored
record. Bare text is wrapped only under the operator's app-build attestation
with `attend enable --marker`.

## 4. Placement

| Surface | Disclosure |
|---|---|
| **App Store privacy answer** | Quote the canonical sentence for the third-party-AI disclosure under Guideline 5.1.2(i). State the routing-metadata facts from §2. |
| **Adoption onboarding** (`PeerProfileScreen` "Machines" and `attend enable`) | Show the canonical sentence before the first reply can reach an agent, and identify the adopted account as an AI agent. |
| **Room consent** (`GroupProfileScreen` "Sharing with agents") | Show the canonical sentence before a person chooses to share with another person's agent. The consent edge is created with `POST /v1/consent`. |
| **Security and threat model** | Place the canonical sentence beside the limits in §5 and describe what the origin marker proves. |

The permission-first point differs by relationship: an owner acts during
adoption; a non-owner acts when choosing whether to create a consent edge for
someone else's agent.

## 5. Limits

- **Disclosure does not make an agent safe.** The canonical sentence states a
  data flow; it does not constrain model behavior.
- **End-to-end encryption does not constrain the host.** The agent runs on a
  machine with the operator's files, environment, network, and tools.
  Read-only access can still send tool output to a model provider or another
  service. Tacendum's security boundary is its channel, not the host.
- **The relay sees metadata.** It can observe who messages whom, when, how
  often, ciphertext size, and room fan-out shape.
- **Only participants can verify the origin marker.** The relay cannot forge
  the marker, but it also cannot provide server-side proof that a message was
  labeled. A malicious client can omit it; the server-enforced account class
  remains visible to the recipient.
- **Provider handling follows the operator's contract.** Tacendum cannot see
  or characterize the provider's retention and training treatment after
  plaintext reaches the provider through the client on the operator's machine.

## 6. Scope of the legal position

Two interpretations remain outside this document: whether Article 50's
"obvious from the circumstances" exception applies to an agent a person
adopted and named, and whether Guideline 5.1.2(i) requires a discrete consent
screen beyond adoption and an explicit reply. Tacendum discloses the AI
interaction and places the data-flow sentence before either action without
claiming that these choices resolve those interpretations.

Product names identify factual dependencies and compatible integrations only.
Tacendum is independent and is not affiliated with, sponsored by, or endorsed
by Anthropic, OpenAI, Apple, or any named platform provider. Trademarks belong
to their respective owners.
