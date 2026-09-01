import { DEVICE_NOUN, type DeviceSlotClass } from './deviceNoun';

/**
 * The device-linking copy deck — one deck for the
 * three linking surfaces, consent-grade, and deliberately PURE: no api, no
 * db, no react-native beyond the noun token, so device-noun.test.ts can load
 * it per idiom exactly as it loads blocking/safety/vault (the device-noun
 * discipline). Every device-naming sentence interpolates `DEVICE_NOUN` —
 * hardcoding any device noun here fails that suite on the idioms it lies to.
 */
export const LINKING_COPY = {
  /** Scan side, before the camera: what scanning does and does not do. */
  scanIntro:
    'Scan the code the new device is showing. Nothing links yet — a scanned ID alone can never join your devices.',
  /** Scan side, code on screen: the dual-confirmation instruction (the existing device confirms FIRST). */
  codeInstruction: `Compare this code with the one on the new device. If every group matches, confirm here on this ${DEVICE_NOUN} first, then on the new device.`,
  /** New-device side, code on screen. `who` comes from personName /
   * shortId — the "who is asking" rendering. */
  codeInstructionNew: (who: string) =>
    `${who} wants to link this device to their account. Compare the code on both screens — confirm only if every group matches.`,
  /** The stall, stated (shown while waiting for the other side). */
  waiting:
    'Waiting for the new device to confirm. Nothing is linked until it does — both devices confirm one code, and both keys sign.',
  /** The pinned history-stance sentence, verbatim — byte-pinned by the
   * link-ceremony suite; do not reword casually. */
  historyStance: 'This device shows messages from today forward.',
  /** New-device side, refused because this install is lived-in (client half). */
  notPristine: `This ${DEVICE_NOUN} already has a life of its own — conversations, machines, or consent decisions. Only a fresh install can be linked, so nothing it holds can leak into another account's devices.`,
  /** Roster screen: the amicable removal. */
  unlinkConfirm: (name: string) =>
    `Unlink ${name}? It keeps what it already received and continues as its own account. Your other devices stop sending to it.`,
  /** Roster screen: the lost/stolen removal (honest cost stated). */
  revokeConfirm: (name: string) =>
    `Revoke ${name}? Its key can never sign in again. It keeps what it already received — revoking stops anything new from reaching it, it cannot take back the past.`,
  /** Per-device drill-down: the list is local truth, per device (a
   * human act is never propagated). Reworded deliberately: the old
   * sentence promised a verification act this screen does not offer. */
  verificationLocal: `This list is this ${DEVICE_NOUN}'s own record of your devices. Each device keeps its own list — nothing here is copied between them.`,
  /** The collapsed refusal, rendered honestly: the server deliberately does
   * not say which condition refused. */
  refused:
    'That did not work. The link may have expired, or the slot may be taken — start again from the new device.',
  /** No verification code could be derived: the
   * ceremony refuses rather than rendering a blank code region. */
  noCode:
    'A verification code could not be built for these two devices. Nothing was confirmed and nothing linked — start again from the other device.',
  /** Scan side: the slot the offer declares for the new device (the
   * offering device declares; in v1 the only slot a link can occupy is the
   * one this device is not). `slot` interpolates via `slotLabel` — the
   * invariant: slot words are never spelled outside deviceNoun.ts. */
  newDeviceSlot: (slot: string) =>
    `The new device will join as the account's ${slot}. An account holds one of each kind.`,
  /** New-device side, above the confirm: what the acceptance signature
   * asserts about THIS device (a signed slot assertion the
   * signer cannot read is not consent). */
  slotAssertion: (slot: string) => `This ${DEVICE_NOUN} will join as the account's ${slot}.`,
  /** New-device side: the offer names a slot class this device is not — in
   * v1 that means both devices occupy the same class, and the ceremony is
   * refused honestly instead of signing a falsehood. */
  classMismatch: `This ${DEVICE_NOUN} is the same kind of device as the one that sent the request. An account links one of each kind — two of the same kind cannot be linked.`,
  /** The one chokepoint for slot words that reach glass: a
   * ROSTER row names a remote device of unknown platform, so the slot value
   * itself — spelled only in deviceNoun.ts — is the
   * never-wrong generic; every sentence about THIS device speaks the idiom
   * noun above. */
  slotLabel: (slot: DeviceSlotClass | 'desktop'): string => slot,
  /** The ONE Settings row that opens the roster. Lives in the
   * deck, not in SettingsScreen's COPY, so the label rides the same
   * chokepoint as every other linking sentence: "devices" is the generic
   * plural the deck already speaks — no idiom noun, deliberately, because
   * the row names the ACCOUNT's devices, never this one. */
  settingsRow: 'Linked devices',
} as const;
