import LibSignalClient
import UserNotifications

/**
 * The notification-service extension.
 *
 * iOS hands it a push carrying `mutable-content: 1` and the ciphertext the
 * server queued but cannot read, and gives it roughly 30 seconds and roughly
 * 24 MB of dirty memory to turn that into something worth showing.
 *
 * THE ORDER OF OPERATIONS IS THE WHOLE DESIGN:
 *
 *   1. Decide what may be shown, BEFORE decrypting. If previews are disarmed
 *      or the level is `none`, nothing is decrypted at all — which also means
 *      no message key is consumed, so the app gets the ciphertext intact over
 *      the socket exactly as it did before this extension existed.
 *
 *   2. Decrypt under the cross-process lock, so the app cannot be advancing
 *      the same ratchet at the same moment.
 *
 *   3. PERSIST BEFORE RENDERING. Decrypting CONSUMES a Double Ratchet message
 *      key: that ciphertext can never be decrypted again by anyone. If the
 *      plaintext is not written down first, a message can arrive, be
 *      decrypted, flash on the lock screen, and be permanently gone. So a
 *      failed spool write is treated as a failed decryption — the generic
 *      body is shown and the message stays whole.
 *
 *   4. Render.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. No SQLite: op-sqlite is a JSI HostObject
 * and touching it would boot a JavaScript runtime in a process with 24 MB to
 * spend. No Keychain: reaching it needs a shared access group, and adding one
 * rewrites the access group of items that already exist — including the lock
 * passcode. No network. No migration: the store's lifecycle belongs to the
 * app, and an extension running a migration under a 30-second budget with
 * nowhere to report failure is a bad trade.
 *
 * LIMITS WORTH STATING, because each one otherwise reads as a bug: nothing is
 * previewed before the first unlock since boot (the files are not readable
 * yet), nothing while the app is locked or after a duress entry has opened
 * the decoy (there is no separate duress code — the user picks exactly one,
 * and how a duress entry is recognized is deliberately written down only in
 * app/src/lock.ts), and nothing if this process is killed for time or memory
 * — in every case the server's generic body is what appears.
 */
final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var fallback: UNMutableNotificationContent?

  /// What the server sends outside `aps`, which it cannot read.
  private struct Payload: Decodable {
    let from: String
    let ts: Double
    let msgId: String
    let msgType: String
    let payload: String
  }

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    let mutable = request.content.mutableCopy() as? UNMutableNotificationContent
    fallback = mutable

    // Decoded from the REQUEST's own userInfo, before — and independent of —
    // the copy guard below: the blocked check must not be skippable by a
    // copy failure. The server stamps `t` on every alert push it sends
    // (packages/server/src/push/apns.ts), so a sender cannot arrange its
    // absence.
    let push: Payload? = {
      guard let raw = request.content.userInfo["t"],
            let json = try? JSONSerialization.data(withJSONObject: raw),
            let decoded = try? JSONDecoder().decode(Payload.self, from: json)
      else { return nil }
      return decoded
    }()

    // A blocked sender can still put bytes on the wire — blocking is enforced
    // on receipt and is deliberately undetectable to them — so the push still
    // arrives. Checked before ANYTHING happens on their behalf: no badge, no
    // preview, below no ratchet advance, and no banner either. Empty content
    // — no title, no body, no sound — is the platform's one sanctioned way
    // for this extension to DROP an alert rather than rewrite it, under the
    // filtering entitlement declared in TacendumNSE.entitlements; never "just
    // don't call the handler", which makes the system show the ORIGINAL push.
    // Until Apple grants that capability to the provisioning profile, the
    // system presents the empty content instead: a soundless, textless
    // banner — still strictly less than the generic body and default sound
    // that used to announce every message a blocked sender cared to fire.
    // The expiry fallback is replaced FIRST, so a timeout racing this branch
    // cannot resurrect the banner. What remains is the platform's own floor,
    // the same one a crash has: an extension killed before this line shows
    // the server's generic body. So does a reboot no one has unlocked since —
    // the mirror is unreadable before first unlock, and an unreadable mirror
    // reads as empty, the same fail-closed-for-previews direction every other
    // mirror takes. Both windows end at the app, which drops blocked mail on
    // receipt.
    if let push, PreviewPolicy.blocked().contains(push.from) {
      let nothing = UNMutableNotificationContent()
      fallback = nothing
      deliver(nothing)
      return
    }

    guard let content = mutable else {
      deliver(request.content)
      return
    }

    // THE SOUND, before anything else is decided about this banner and
    // independent of all of it. The server's alert carries `sound: default`
    // (packages/server/src/push/apns.ts) and every branch below keeps it —
    // the generic body while locked, the preview while armed, the fallback
    // on expiry — unless the owner turned message sounds OFF in Settings
    // (app/src/messageSound.ts, mirrored to the App Group as `message-sound`
    // exactly as `preview-level` is). Deliberately NOT behind the armed
    // lease: a banner that would sound while the phone is locked sounds
    // because the owner left it on, and stays silent because they turned it
    // off — the lock and the decoy states gain no new signal either way,
    // since OFF can only subtract. The blocked drop above delivered empty
    // content, which has no sound to subtract; the continuation jails below
    // mute their own banners on their own condition lines. `content` IS the
    // expiry fallback, so a timeout after this line honours the choice too.
    if !PreviewPolicy.messageSound() {
      content.sound = nil
    }

    // A push that carries no readable payload badges nothing and previews
    // nothing — there is no sender to attribute either to.
    guard let push else {
      deliver(content)
      return
    }

    // THE BADGE, before any preview gate, because it is not a preview. Since
    // the `notify` bit, the server pushes only real messages — carriers queue
    // silently — so every launch of this extension is one new message, and
    // arithmetic on two small files replaces the server-side count that was
    // removed for counting read receipts as mail. Deliberately independent of
    // `armed` and the level: a locked phone still counts its mail, it just
    // does not display any of it.
    if let badge = BadgeCounter.incrementedBadge() {
      content.badge = NSNumber(value: badge)
    }

    // THE CONTINUATION COUNT, beside the badge and in
    // its trust class: the server folds this sender's banners into one on the
    // device (`apns-collapse-id` = the sender, minted in packages/server/src/
    // push/apns.ts on the alert arm), so of a burst only the LAST banner
    // survives — and a survivor showing only the last message under-reports
    // the burst. This counts extension launches per sender so the `.full`
    // render below can say "N new messages" instead. A plain `let`, never a
    // guard: an unknowable count renders as a first message, and nothing
    // about the counter may gate the spool — every run still spools its
    // message whatever this returns.
    //
    // VERSION SKEW, stated honestly (there is no wire dependency in either
    // direction): an app without this change under the new server gets
    // replacing banners WITHOUT counts — the survivor shows only the last
    // message. This app under an old server (no collapse id) gets today's
    // stacking, every banner its own — the later banners of a burst then
    // carry the count as their body, redundant beside the stack but never
    // false.
    let coalesced = CollapseCounter.incrementedCount(for: push.from)

    // Step 1 of the PREVIEW decision. Everything below is skipped when the
    // answer is "show nothing", and skipping it is what leaves the ciphertext
    // intact for the app. `armedAndWritable` is the write gate: a lease that
    // cannot be rewritten is a lease that can never be revoked, and a
    // permission that cannot be taken away must not be usable.
    let level = PreviewPolicy.level()
    guard PreviewPolicy.armedAndWritable(), level != .none else {
      deliver(content)
      return
    }

    guard let selfId = PreviewPolicy.selfUserId() else {
      deliver(content)
      return
    }

    guard let body = decryptAndSpool(push, selfId: selfId) else {
      deliver(content)
      return
    }

    // Re-checked between the decrypt and the render: a duress entry or a
    // relock that landed while the ratchet was turning revokes the preview of
    // the message in flight, not just the next one. The decrypt itself was
    // correct either way — the plaintext is already spooled for the app, and
    // only what appears on screen is in question. This narrows the race to
    // the instructions between here and `deliver`; the platform offers
    // nothing that closes it.
    guard PreviewPolicy.armed() else {
      deliver(content)
      return
    }

    let rendered = Self.classify(body, selfId: selfId)

    // Transport never becomes a banner. The closest honest rendering is the
    // fallback content untouched: no preview, no attribution, no thread —
    // for a reaction, an edit, a read receipt, `call.` and `x.`, in a room
    // exactly as 1:1. Deliberately NOT the blocked branch's empty-content
    // drop: that suppression exists for a sender the owner refused, and
    // whether a misbehaving client's carrier should vanish entirely under
    // the same entitlement is its own decision, not a side effect to
    // inherit here.
    guard !rendered.silent else {
      deliver(content)
      return
    }

    // THE APPROVAL ASK, ahead of the room and 1:1
    // arms so neither can restyle it and no continuation jail can reword
    // it. At `.full` — restated on the render's own condition line, the
    // discipline the jails below established — the banner says WHO (the
    // mirror's name for the authenticated sender, the same trust class as
    // every title in this file) and the fixed constant from
    // `approvalBody()`: never a command byte, never a diff line, and never
    // the continuation body even when the burst coalesced — an approval
    // deserves its own words, so this branch returns before both jails and
    // never consults the counter. Every other level delivers the fallback
    // untouched, byte-identical to the silence every x.* rendered
    // yesterday. NEVER a category, NEVER an answer action:
    // device unlock cannot distinguish the duress passcode from
    // the real one — that comparison exists only inside app/src/lock.ts —
    // so the only affordance is the tap, through the app's own
    // duress-aware unlock, into the thread whose card is the answer
    // surface.
    if rendered.approval {
      if level == .full {
        content.title = Self.senderTitle(push.from)
        content.body = Self.approvalBody()
        content.threadIdentifier = push.from
      }
      deliver(content)
      return
    }

    // Step 4, a room. The name comes from the app's
    // mirror and NOWHERE else — a `grp.msg` cannot carry one, and nothing
    // sender-controlled may title a banner.
    //   .full    the room's name, plus a fixed constant when there is one —
    //            and for a mention of this device's owner, the mirror's own
    //            name for who did it ("Ana mentioned you"): mirror bytes
    //            composed with a constant, never a payload byte
    //   .sender  who wrote — never what, and never which room: the room's
    //            name is content about the owner's life, which is exactly
    //            what `.sender` promises to withhold. A mention renders
    //            HERE exactly as any other message, deliberately: "you were
    //            mentioned" is a fact about what was written — this level
    //            does not even say "Photo" — so surfacing mentions at
    //            `.sender` needs the level's promise amended first, not an
    //            implementation that quietly stretches it.
    // A room the mirror cannot name (an invitation not yet accepted, a
    // mirror lost to a relock) renders the generic body: titling it with the
    // sender would dress a room message as a 1:1 — misattribution —
    // and showing less than the app is the permitted direction.
    if let g = rendered.roomId {
      if level == .full, let name = PreviewPolicy.groupName(g) {
        content.title = name
        if let shown = rendered.shown {
          // Who mentioned them, when the app's mirror can say:
          // the same source and trust class as the title one
          // line up — app-written, deleted on relock and duress, never a
          // byte of this payload. `push.from` is the address the decrypt
          // above succeeded against, so the ratchet vouches for it. A peer
          // the mirror cannot name keeps the bare constant: showing less.
          if rendered.mentioned, let who = PreviewPolicy.peerName(push.from) {
            content.body = "\(who) mentioned you"
          } else {
            content.body = shown
          }
        }
        // The continuation: the room's name still titles it, a
        // mention of the owner still wins the body — the count replaces only
        // an ordinary body — and the burst buzzes once, not N times.
        // `level == .full` is restated in the condition, redundantly, so the
        // full-only jail is a fact of this LINE that the contract test pins, not of
        // surrounding context.
        if level == .full, let n = coalesced, n > 1 {
          if !rendered.mentioned { content.body = Self.continuationBody(n) }
          content.sound = nil
        }
        // Prefixed so a room id minted to collide with a peer's id cannot
        // merge its banners into that peer's 1:1 thread. Not rendered text —
        // the group id itself never appears on screen.
        content.threadIdentifier = "g/\(g)"
        deliver(content)
        return
      }
      if level == .sender {
        content.title = Self.senderTitle(push.from)
        content.threadIdentifier = push.from
      }
      deliver(content)
      return
    }

    // Declared room traffic that earned no room above — a `grp.msg` the
    // strict guard refused, an admin envelope whose `g` would not shape —
    // must not take the 1:1 sender title below: the same misattribution, by
    // prefix this time. The generic banner shows less, the permitted
    // direction.
    if body.hasPrefix("{\"tcm\":\"grp.") {
      deliver(content)
      return
    }

    // Step 4, 1:1. `sender` shows who, never what.
    content.title = Self.senderTitle(push.from)
    if level == .full, let shown = rendered.shown {
      content.body = shown
    }
    // The continuation, at `.full` ONLY: `.sender` and every
    // degraded level keep today's exact rendering, pinned byte-for-byte in
    // nse.preview.contract.test.ts. A mention of the owner still wins the
    // body; the burst buzzes once, not N times.
    if level == .full, let n = coalesced, n > 1 {
      if !rendered.mentioned { content.body = Self.continuationBody(n) }
      content.sound = nil
    }
    content.threadIdentifier = push.from
    deliver(content)
  }

  /**
   * The banner's WHO: the app's mirror name for the sender — the same
   * source, trust class and lifecycle as the mention body above and the
   * room title (app-written under `personName`'s precedence, deleted on
   * relock and duress, never a payload byte) — else the app's shortId
   * convention (person.ts): the TAIL of the id the decrypt succeeded
   * against, never the full ULID.
   *
   * The fragment fallback is deliberate where the mirror fails closed: an
   * account id is not sender-chosen display text — it is the authenticated
   * address this banner is already threaded by — and every app surface
   * degrades to exactly this fragment for a peer who shared no name
   * (person.ts's opening rule). A generic title instead would leave a
   * `.full` body unattributed and make two unnamed senders' banners
   * indistinguishable.
   */
  static func senderTitle(_ from: String) -> String {
    if let name = PreviewPolicy.peerName(from) { return name }
    return from.count <= 8 ? from : "…" + String(from.suffix(8))
  }

  /**
   * The coalesced banner's WHAT: a fixed constant composed with the
   * count and nothing else. The signature takes an Int so a payload byte
   * cannot even be OFFERED — the one-directional rule, enforced by the type.
   * The number is arithmetic on extension launches (CollapseCounter), never a
   * byte of any payload; the contract test pins this line literally.
   */
  static func continuationBody(_ n: Int) -> String { "\(n) new messages" }

  /**
   * The approval banner's WHAT: a fixed constant,
   * full stop. Where `continuationBody` at least takes an Int, this takes
   * NOTHING — not even a number can ride the line — the one-directional
   * rule enforced by the emptiest possible signature. The contract test
   * pins this line literally, and pins the render branch to compose its
   * body here and nowhere else.
   */
  static func approvalBody() -> String { "Approval requested" }

  /**
   * Decrypt under the store lock and write the plaintext down before returning.
   *
   * Returns nil on any failure, and nil means "show the generic body". That is
   * the honest answer for every case here: a store that will not open, a
   * ciphertext this device cannot decrypt (a message for a session that has
   * moved on, or one the app already took), or a spool write that failed.
   *
   * The spool write is INSIDE the lock and before the return, so the window in
   * which a message key has been consumed but the plaintext is not on disk is
   * as small as it can be made.
   */
  private func decryptAndSpool(_ push: Payload, selfId: String) -> String? {
    guard let root = SharedContainer.protocolStoreRoot(),
          let lockFile = SharedContainer.storeLockFile(),
          let ciphertext = Data(base64Encoded: push.payload)
    else { return nil }

    return try? StoreLock.shared.withLock(at: lockFile) { () -> String? in
      let stores = try TacendumFileStores(root: root)
      guard stores.hasIdentity else { return nil }

      let sender = try ProtocolAddress(name: push.from, deviceId: 1)
      let localAddress = try ProtocolAddress(name: selfId, deviceId: 1)
      let context = TacendumStoreContext()
      let plaintext: Data
      switch push.msgType {
      case "prekey":
        plaintext = try signalDecryptPreKey(
          message: try PreKeySignalMessage(bytes: ciphertext),
          from: sender,
          localAddress: localAddress,
          sessionStore: stores,
          identityStore: stores,
          preKeyStore: stores,
          signedPreKeyStore: stores,
          kyberPreKeyStore: stores,
          context: context
        )
      default:
        plaintext = try signalDecrypt(
          message: try SignalMessage(bytes: ciphertext),
          from: sender,
          to: localAddress,
          sessionStore: stores,
          identityStore: stores,
          context: context
        )
      }

      let body = String(decoding: plaintext, as: UTF8.self)
      // BEFORE returning, and before anything is rendered. See the class note.
      try InboxSpool.write(
        InboxSpool.Entry(msgId: push.msgId, from: push.from, ts: push.ts, body: body)
      )
      return body
    } ?? nil
  }

  /**
   * What one decrypted body may put on the lock screen.
   *
   * `shown` is text that may appear at level `.full` — a plain 1:1 text, or a
   * FIXED constant — and nil means "the generic body". `roomId` is the `g` of
   * a well-shaped `grp.msg`, so the render step can title the banner from the
   * app's name mirror. `silent` marks transport — a carrier, `call.`, `x.`
   * (minus the one named carve-out, `approval` below) — which must not
   * become a banner at all: "silent" renders as the server's fallback
   * content untouched, with no attribution and no thread — kept distinct
   * from the blocked branch's empty-content drop on purpose (see the render
   * step).
   */
  struct Rendered {
    let roomId: String?
    let shown: String?
    let silent: Bool
    /// The decrypted body mentions THIS device's owner — a `mention` whose
    /// `who` contains the published self id. The one
    /// content-derived bit `.full` may spend words on; `.sender` deliberately
    /// ignores it, because "you were mentioned" is a fact about WHAT was
    /// written and `.sender` promises who, never what.
    let mentioned: Bool
    /// The decrypted body is a well-shaped `x.approval` ask:
    /// a bit, never text — the render step composes the fixed
    /// constant itself via `approvalBody()`, so no classify result can put
    /// a payload byte on an approval banner. `.sender` and every degraded
    /// level ignore it exactly as they ignore `mentioned`: a pending
    /// command ask is a fact about what is happening on the owner's
    /// machine, which is what those levels promise to withhold.
    let approval: Bool

    init(
      roomId: String?,
      shown: String?,
      silent: Bool,
      mentioned: Bool = false,
      approval: Bool = false
    ) {
      self.roomId = roomId
      self.shown = shown
      self.silent = silent
      self.mentioned = mentioned
      self.approval = approval
    }
  }

  /**
   * Classify a decrypted body, mirroring the app's `envelope.ts` in the one
   * direction that is safe to mirror: THE EXTENSION MAY ONLY EVER SHOW LESS.
   *
   * **This exists because the decrypted body is NOT always a message.** Most
   * of what travels through the ratchet is a structured envelope — a vault
   * entry, an image, a reply, an edit — and the first version of this file
   * assigned the raw string straight to `content.body`. For a vault envelope
   * that puts the secret's title AND the secret itself on the lock screen as
   * raw JSON; for an image it puts the attachment id and its AES key there.
   * `envelope.ts` states plainly that vault contents must never appear outside
   * the thread, and this was the one place that broke it.
   *
   * The rule is deliberately crude and one-directional: anything that
   * announces itself as structure shows a fixed constant or nothing. A plain
   * text is shown. The app renders structured bodies properly through
   * `previewFor`, which is TypeScript and several hundred lines of envelope
   * handling — reimplementing it here would be a second parser to keep in
   * sync, and every disagreement between them would resolve as "too much on
   * the lock screen". The jest contract suite
   * (app/__tests__/nse.preview.contract.test.ts) pins `previewFor` to every
   * constant and classification this switch relies on, so an app-side change
   * that would strand this file is at least named in a failing test; the
   * Swift half of the agreement is provable only on a device.
   *
   * The cost is that a reply — whose body IS an envelope carrying its text —
   * shows only the sender until this grows a real parser. That is the correct
   * direction to be wrong in.
   *
   * Rooms: a `grp.msg` is unwrapped by the EXACT
   * JSON discriminator — never a substring, so a text that merely quotes the
   * format stays a text — and classified as whatever it wraps, one level
   * deep. A carrier stays a carrier inside a room: a reaction sent into a
   * room raises no banner, exactly as it raises none 1:1.
   */
  /// `selfId` is the id this device decrypts as (`PreviewPolicy.selfUserId`),
  /// taken as a parameter so the switch stays a pure function of its inputs.
  /// It decides exactly one thing: whether a `mention`'s `who` names the
  /// owner. Nil — never the case on the live path, which needed the id to
  /// decrypt at all — reads as "not mentioned", the direction that shows less.
  static func classify(_ body: String, depth: Int = 0, selfId: String? = nil) -> Rendered {
    // `ENVELOPE_SENTINEL` in app/src/envelope.ts. Anything not starting with
    // it is ordinary text, by design.
    guard body.hasPrefix("{\"tcm\":") else {
      return Rendered(roomId: nil, shown: body, silent: false)
    }
    // Transport namespaces are routed ON THE PREFIX, BEFORE parsing, exactly
    // as `isCarrierEnvelope` routes them: `call.` signalling and the reserved
    // `x.` namespace stay silent even in a shape this build has never seen —
    // truncated, oversized, or minted by a future version.
    if body.hasPrefix("{\"tcm\":\"call.") {
      return Rendered(roomId: nil, shown: nil, silent: true)
    }
    if body.hasPrefix("{\"tcm\":\"x.") {
      // The ONE x.* kind this build can NAME: an
      // approval ask, matched by the EXACT JSON discriminator plus the
      // schema's refusing half — never the prefix — because the app cards
      // only what `ApprovalRequestEnvelope` parses and drops the rest
      // invisibly (messaging.ts routes the declared tcm above the generic
      // x. drop only when the union parses), so a banner that announced a
      // malformed ask would say MORE than the thread. Everything else in
      // the namespace — x.typing, x.approval.answer, a future
      // x.approval.close, shapes this build has never seen — keeps today's
      // pre-parse silence, byte for byte. Depth 0 only, stated in the
      // condition like the grp.msg depth guard states its rule twice: the
      // app has no approval consumer inside a room, so a room banner
      // naming one would announce a card no thread will render. The
      // Rendered carries a BIT and no text: the constant lives in
      // `approvalBody()` alone, whose empty signature keeps every payload
      // byte out (the `continuationBody` discipline, tightened).
      if depth == 0, Self.plausibleApproval(body) {
        return Rendered(roomId: nil, shown: nil, silent: false, approval: true)
      }
      return Rendered(roomId: nil, shown: nil, silent: true)
    }
    // The exact JSON discriminator, never a lexical prefix: a prefix test
    // would label malformed or crafted text as a real attachment. And only
    // FIXED constants are shown: never the filename, never coordinates,
    // never any sender-controlled byte.
    guard let data = body.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data),
          let map = object as? [String: Any],
          let kind = map["tcm"] as? String
    else { return Rendered(roomId: nil, shown: nil, silent: false) }
    switch kind {
    // The carrier set, kept in step with `isCarrierEnvelope`: transport
    // that rewrites existing rows and must never raise a banner. Honest
    // traffic never even lands here — carriers ride `notify: false` and the
    // server queues them without a push — so this is defence against a
    // client that sets the bit anyway.
    case "react", "profile", "edit", "del", "read":
      return Rendered(roomId: nil, shown: nil, silent: true)
    case "image": return Rendered(roomId: nil, shown: "Photo", silent: false)
    case "file": return Rendered(roomId: nil, shown: "Document", silent: false)
    case "loc": return Rendered(roomId: nil, shown: "Location", silent: false)
    case "msg":
      // The agent's bare words in the attested-agent wrapper (`AgentTextEnvelope`,
      // packages/shared/src/ai-origin.ts): CONVERSATION, shown at `.full`
      // exactly as an unwrapped text is — the owner who attested `--marker`
      // must not lose the lock-screen words the un-attested posture shows.
      // The guard approximates the schema's strict
      // half on the mention arm's exact terms: `text` a non-empty
      // non-envelope string within MAX_AGENT_TEXT (20 000, the mirror of
      // MAX_GROUP_BODY) — an envelope the app's parser refuses renders
      // "Unsupported message" in the thread, and a banner that showed its
      // words would say MORE than the app. Depth 0 only: in a room the
      // fixed-constants rule holds, so a `msg` inside a `grp.msg`
      // previews as the generic body exactly as bare words in a room do —
      // the `constant` line below never sees a `shown` from this arm.
      guard depth == 0,
            let text = map["text"] as? String, !text.isEmpty,
            !text.hasPrefix("{\"tcm\":"),
            text.count <= 20_000
      else { return Rendered(roomId: nil, shown: nil, silent: false) }
      return Rendered(roomId: nil, shown: text, silent: false)
    case "mention":
      // A mention IS conversation: its `text` and its
      // `who` are sender-controlled bytes and ids, so neither may reach a
      // banner. The one fact worth a constant is the reason the kind exists:
      // this device's owner is in `who`. The guard approximates the strict
      // half of the app's `MentionEnvelope` exactly as the `grp.msg` guard
      // below approximates its schema — `who` is 1–12 26-character ids
      // (GROUP_MAX_MEMBERS, packages/shared/src/group-fold.ts), `text` is a
      // non-empty non-envelope string — because an envelope the app's parser
      // refuses renders "Unsupported message" in the thread, and a lock
      // screen that said "Mentioned you" about it would say more than the
      // app. Same residual as below, stated plainly: ULID character classes
      // are not re-run, so a crafted envelope can pass here and fail there —
      // it then shows this fixed constant, never a sender byte.
      guard let who = map["who"] as? [String],
            (1...12).contains(who.count),
            who.allSatisfy({ $0.count == 26 }),
            let text = map["text"] as? String, !text.isEmpty,
            !text.hasPrefix("{\"tcm\":")
      else { return Rendered(roomId: nil, shown: nil, silent: false) }
      guard let selfId, who.contains(selfId) else {
        // A real mention of somebody else: conversation, previewed as the
        // generic body — the same "less than the app" a reply gets.
        return Rendered(roomId: nil, shown: nil, silent: false)
      }
      return Rendered(roomId: nil, shown: "Mentioned you", silent: false, mentioned: true)
    case "grp.msg":
      // One level only, exactly the schema's refusal: an inner
      // `grp.*` cannot be parsed by the app at all, so nothing is attributed
      // to it — not even the room. The depth guard is the same rule stated
      // twice, so removing either check alone cannot open unbounded
      // recursion.
      //
      // The other bounds are the wire schema's strict half, approximated:
      // `g` and `m` are 26-character ULIDs, `b` is 1–20 000 characters
      // (MAX_GROUP_BODY), `sq` when present is a nonnegative integer — each
      // of these refuses the WHOLE envelope at the app's parser, so an
      // envelope failing one must not earn a room title here that the
      // thread will render as "Unsupported message". Not a validator: zod's
      // character classes are not re-run, so a crafted envelope can still
      // pass here and fail there — it then shows a fixed constant or the
      // generic body, never a sender byte. `rd` is deliberately NOT checked,
      // in either direction, because the app's parser never refuses over it
      // (the clamp rule: the digest is worth losing, the message is not).
      guard depth == 0,
            let g = map["g"] as? String, g.count == 26,
            let b = map["b"] as? String, !b.isEmpty,
            !b.hasPrefix("{\"tcm\":\"grp."),
            (map["m"] as? String)?.count == 26,
            b.count <= 20_000,
            Self.plausibleSq(map["sq"])
      else { return Rendered(roomId: nil, shown: nil, silent: false) }
      let inner = classify(b, depth: 1, selfId: selfId)
      if inner.silent {
        // A reaction, edit or read receipt inside a room: no banner, no
        // room, no sender — as close to "nothing happened" as the platform
        // allows, and the same answer the app gives.
        return Rendered(roomId: nil, shown: nil, silent: true)
      }
      // FIXED CONSTANTS ONLY IN A ROOM — never the wrapped text
      // ("never the body"). The app runs the full schema over this envelope
      // (`rd`'s alphabet, `m`'s, `sq`) and renders "Unsupported message" for
      // whatever fails it; this file cannot re-run that schema, so any
      // sender-written byte it showed could be a byte the app will refuse to
      // show, and the lock screen would then say MORE than the thread. A
      // constant cannot disagree in that direction. The cost is that a plain
      // text in a room previews as the generic body where the app's chat
      // list shows its words — more conservative than the app, deliberately.
      let constant = b.hasPrefix("{\"tcm\":") ? inner.shown : nil
      // `mentioned` survives the unwrap: a mention in a room is the shape
      // the feature exists for, and it is still only a bit — the words and
      // the ids stayed behind in the inner classification.
      return Rendered(roomId: g, shown: constant, silent: false, mentioned: inner.mentioned)
    // Room ADMINISTRATION is room traffic: an invitation or a
    // membership change titled with the WRITER would dress itself as a 1:1
    // from them — a banner the person taps into an empty thread. The app
    // previews each as a fixed constant ("New room", "Members changed", …);
    // this side shows the generic body under the room's own title, which is
    // less. An envelope whose `g` cannot even be shaped is room traffic
    // without a room — the render step's prefix guard keeps the 1:1 sender
    // title off it.
    case "grp.new", "grp.roster", "grp.del", "grp.set":
      guard let g = map["g"] as? String, g.count == 26
      else { return Rendered(roomId: nil, shown: nil, silent: false) }
      return Rendered(roomId: g, shown: nil, silent: false)
    default: return Rendered(roomId: nil, shown: nil, silent: false)
    }
  }

  /// `sq` as the schema takes it: absent, or a nonnegative integer. A JSON
  /// boolean arrives as an NSNumber too, and zod refuses it, so it is told
  /// apart explicitly.
  private static func plausibleSq(_ value: Any?) -> Bool {
    guard let value else { return true }
    guard !(value is Bool), let number = value as? NSNumber else { return false }
    let sq = number.doubleValue
    return sq >= 0 && sq.rounded() == sq
  }

  /**
   * The schema's refusing half for `x.approval` (@tacendum/shared
   * approval-envelope.ts), approximated exactly as the `grp.msg` and
   * `mention` guards approximate theirs: every bound whose failure refuses
   * the WHOLE envelope at the app's parser is restated here, because an
   * envelope the app drops invisibly must not earn a banner that says an
   * approval exists. `k` is deliberately NOT checked — the schema
   * `.catch`es it to 'other', so no `k` can refuse. `p`'s bound counts
   * UTF-16 code units, the unit zod's `.max()` counts. Same residual as
   * the other guards, stated plainly: ULID and hex character classes are
   * not re-run, so a crafted envelope can pass here and fail there — it
   * then shows the fixed constant, never a sender byte.
   */
  private static func plausibleApproval(_ body: String) -> Bool {
    guard let data = body.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data),
          let map = object as? [String: Any],
          map["tcm"] as? String == "x.approval",
          let q = map["q"] as? String, q.count == 26,
          let p = map["p"] as? String, !p.isEmpty,
          p.utf16.count <= 16_384,
          Self.plausibleInt(map["x"], min: 30, max: 3_600),
          let verbs = map["a"] as? [String],
          (1...8).contains(verbs.count),
          verbs.allSatisfy({ (1...16).contains($0.count) })
    else { return false }
    // Optional-but-refusing, both of them: absent is fine, present must
    // shape (zod's `.optional()` refuses a present-but-wrong member, and
    // null with it).
    if let s = map["s"] {
      guard let tag = s as? String, tag.count == 6, tag.hasPrefix("s-")
      else { return false }
    }
    if let n = map["n"] {
      guard Self.plausibleInt(n, min: 1, max: 64) else { return false }
    }
    return true
  }

  /// A REQUIRED integer member as the schema takes one: an integer in
  /// [min, max]. A JSON boolean arrives as an NSNumber too, and zod refuses
  /// it, so it is told apart explicitly — `plausibleSq`'s rule, with bounds
  /// and without the absent-is-fine clause.
  private static func plausibleInt(_ value: Any?, min: Double, max: Double) -> Bool {
    guard let value, !(value is Bool), let number = value as? NSNumber
    else { return false }
    let v = number.doubleValue
    return v >= min && v <= max && v.rounded() == v
  }

  /// Hand the content over exactly once.
  private func deliver(_ content: UNNotificationContent) {
    guard let handler = contentHandler else { return }
    contentHandler = nil
    handler(content)
  }

  override func serviceExtensionTimeWillExpire() {
    // Out of time. Whatever exists is better than nothing, and `deliver`
    // guarantees the handler is not called twice — which it now can be, since
    // decryption made this class capable of taking real time.
    guard let fallback else { return }
    deliver(fallback)
  }
}
