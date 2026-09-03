import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiRequestError } from '../api';
import * as qr from '../qr';
import { DEVICE_SLOT_CLASSES, type DeviceSlotClass } from '../deviceNoun';
import { PickCancelled, PickDenied, PickTooLarge, pickImageFile } from '../media';
import { safetyGroups } from '../safety';
import { useTheme } from '../theme';
import {
  InlineError,
  PrimaryButton,
  RuledLabel,
  ScreenHeader,
  TextAction,
} from '../ui/primitives';
import {
  LINKING_COPY,
  localDeviceClass,
  NoVerificationCodeError,
  OffererCeremony,
} from '../linking';
import type { ProfileRow } from '../db';

/**
 * "Link a device" — the SCAN side of the ceremony.
 *
 * The camera and image paths are the existing scan pipeline, unchanged
 * (qr.ts — same guards, same single validator, same refusals): context
 * supplies semantics, and the payload stays the bare 26-char ULID. What this
 * screen adds is the CEREMONY around the scan — the verification code from
 * both identity keys, the human confirmation on THIS device first, and the
 * signed offer — none of which mints a payload format.
 *
 * THE PROBE'S HONEST COST: every completion probe consumes
 * one of the JOINER's one-time prekeys (GET /v1/keys is an atomic consume),
 * so the pacing backs off — 15 s, 15 s, 30 s, 30 s, then 60 s. Worst case
 * over the full 10-minute offer window: 4 stepped probes (90 s) + 8 tail
 * probes = 12 consumed prekeys, inside the pinned per-target
 * aggregate of 30 one-time-prekey fetches/day; a completed ceremony
 * typically costs 1–2. The ceremony module's durable pending row covers the
 * unmounted case, so this screen never needs to poll harder to avoid
 * losing the result.
 */

/** Stepped probe delays, then `LINK_POLL_TAIL_MS` forever after — exported
 * so the link-ceremony suite can pin the worst-case prekey spend against
 * that budget. */
export const LINK_POLL_STEPS_MS = [15_000, 15_000, 30_000, 30_000] as const;
export const LINK_POLL_TAIL_MS = 60_000;

/** Which reader produced the ULID — the same thrown class means a different
 * thing on each path (see `readError`). */
type ScanSource = 'camera' | 'photo';

type Phase =
  | { name: 'scan'; error: string | null }
  | { name: 'starting' }
  | { name: 'code'; ceremony: OffererCeremony; klass: DeviceSlotClass; busy: boolean }
  | { name: 'waiting'; ceremony: OffererCeremony }
  | { name: 'linked' }
  | { name: 'failed'; message: string };

/**
 * Every way READING the code can fail, in our own words (StartChatScreen's
 * `photoError` idiom: the class is the contract, never the thrown text).
 * `source` is which reader ran: the same `QrImageUnreadable` means "the
 * camera would not open" on one path and "that file would not decode" on
 * the other, and `QrNoCode` is a cancelled scan on the camera (no sentence
 * — qr.ts says so) but a real answer about a chosen photo. Null means back
 * to the intro without a word. */
function readError(error: unknown, source: ScanSource): string | null {
  if (error instanceof PickCancelled) return null;
  if (error instanceof qr.QrNoCode) {
    return source === 'camera' ? null : LINKING_COPY.photoNoCode;
  }
  if (error instanceof qr.QrOwnId) {
    return 'That is this device’s own code — scan the NEW device’s code.';
  }
  if (error instanceof qr.QrNotAnId) return 'That code isn’t a Tacendum ID.';
  if (error instanceof qr.QrAmbiguous) return LINKING_COPY.qrMultiple;
  if (error instanceof PickDenied) return LINKING_COPY.photosDenied;
  if (error instanceof PickTooLarge) return LINKING_COPY.photoTooBig;
  return source === 'camera' ? LINKING_COPY.cameraFailed : LINKING_COPY.photoUnreadable;
}

/**
 * Every way the CEREMONY can fail past the reader. A server answer is the
 * collapsed refusal the server deliberately made; anything else — offline,
 * DNS, a timeout — never reached it, and "expired or taken" about a request
 * that was never delivered is a lie about the person's own code. The
 * accounts module's `isRefusal` line, drawn here. */
function ceremonyError(error: unknown): string {
  if (error instanceof NoVerificationCodeError) return LINKING_COPY.noCode;
  if (error instanceof ApiRequestError) return LINKING_COPY.refused;
  return LINKING_COPY.transportFailed;
}

/** `m:ss` from a remaining span; never negative. */
function clockFrom(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

export function LinkDeviceScreen({
  profile,
  onBack,
  onDone,
}: {
  profile: ProfileRow;
  onBack: () => void;
  onDone: () => void;
}) {
  const t = useTheme();
  const [phase, setPhase] = useState<Phase>({ name: 'scan', error: null });
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const beginFrom = useCallback(
    async (read: () => Promise<string>, source: ScanSource) => {
      setPhase({ name: 'starting' });
      let scannedId: string;
      try {
        scannedId = await read();
      } catch (error) {
        if (mounted.current) setPhase({ name: 'scan', error: readError(error, source) });
        return;
      }
      try {
        const ceremony = await OffererCeremony.begin(scannedId);
        if (!mounted.current) return;
        // The declared slot (the offering device declares): in v1 an
        // account links one phone and one tablet, and this device occupies
        // its own class — so the only slot a link can occupy is the other
        // one. Declared, displayed, and ENFORCED by the joining device,
        // which refuses to sign a class it is not — a
        // second device of the same class dies visibly on the far screen.
        const klass =
          DEVICE_SLOT_CLASSES.find(slot => slot !== localDeviceClass()) ??
          localDeviceClass();
        setPhase({ name: 'code', ceremony, klass, busy: false });
      } catch (error) {
        if (mounted.current) setPhase({ name: 'scan', error: ceremonyError(error) });
      }
    },
    [],
  );

  // The completion probe (checkLinked): stepped-backoff pacing (see the
  // budget arithmetic in the header), bounded by the offer's own expiry
  // inside the ceremony.
  useEffect(() => {
    if (phase.name !== 'waiting') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tick = 0;
    const schedule = () => {
      const delay = LINK_POLL_STEPS_MS[tick] ?? LINK_POLL_TAIL_MS;
      tick += 1;
      timer = setTimeout(() => {
        void phase.ceremony
          .checkLinked()
          .then(linked => {
            if (cancelled || !mounted.current) return;
            if (linked) setPhase({ name: 'linked' });
            // The ceremony fails itself only at its own expiry (checkLinked):
            // said as an expiry, not as a refusal.
            else if (phase.ceremony.phase === 'failed') {
              setPhase({ name: 'failed', message: LINKING_COPY.expired });
            } else schedule();
          })
          .catch(() => {
            if (!cancelled && mounted.current) schedule();
          });
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [phase]);

  // The offer's own clock: re-read once a second while waiting. Wall-clock
  // on purpose — the ceremony's expiry check reads the same one.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (phase.name !== 'waiting') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const confirm = useCallback(() => {
    if (phase.name !== 'code' || phase.busy) return;
    setPhase({ ...phase, busy: true });
    void phase.ceremony
      .confirm(phase.klass)
      .then(() => {
        if (mounted.current) setPhase({ name: 'waiting', ceremony: phase.ceremony });
      })
      .catch(error => {
        if (mounted.current) setPhase({ name: 'failed', message: ceremonyError(error) });
      });
  }, [phase]);

  const stopWaiting = useCallback(() => {
    if (phase.name !== 'waiting') return;
    // This object probes no further; the durable row still does — linking.ts
    // `cancel` says why the row is kept, and the copy below says so too.
    phase.ceremony.cancel();
    setPhase({ name: 'scan', error: null });
  }, [phase]);

  return (
    <View style={[styles.screen, { backgroundColor: t.color.paperGround }]}>
      <ScreenHeader title="Link a device" onBack={onBack} testIDBack="link-device-back" />
      <ScrollView contentContainerStyle={styles.body}>
        {phase.name === 'scan' && (
          <>
            <Text style={[t.type.body, { color: t.color.inkStrong }]}>
              {LINKING_COPY.scanIntro}
            </Text>
            {phase.error !== null && (
              <InlineError message={phase.error} testID="link-scan-error" />
            )}
            <PrimaryButton
              label="Scan with camera"
              testID="link-scan-camera"
              onPress={() =>
                void beginFrom(() => qr.readIdFromCamera(profile.userId), 'camera')
              }
            />
            <TextAction
              label="Choose a photo of the code"
              testID="link-scan-photo"
              onPress={() =>
                void beginFrom(async () => {
                  const file = await pickImageFile('library');
                  return qr.readIdFromImage(file.uri, profile.userId);
                }, 'photo')
              }
            />
          </>
        )}

        {phase.name === 'starting' && (
          <Text style={[t.type.body, { color: t.color.inkMuted }]}>Fetching keys…</Text>
        )}

        {phase.name === 'code' && (
          <>
            <RuledLabel label="Verification code" />
            <View style={styles.groups} testID="link-code">
              {safetyGroups(phase.ceremony.code).map((group, i) => (
                <Text
                  key={i}
                  selectable
                  style={[t.type.safetyNumber, styles.group, { color: t.color.inkStrong }]}
                >
                  {group}
                </Text>
              ))}
            </View>
            <Text style={[t.type.body, { color: t.color.inkStrong }]}>
              {LINKING_COPY.codeInstruction}
            </Text>
            <Text style={[t.type.compactBody, { color: t.color.inkMuted }]} testID="link-slot">
              {LINKING_COPY.newDeviceSlot(LINKING_COPY.slotLabel(phase.klass))}
            </Text>
            <PrimaryButton
              label="The codes match"
              testID="link-confirm-code"
              disabled={phase.busy}
              onPress={confirm}
            />
          </>
        )}

        {phase.name === 'waiting' && (
          <>
            <Text style={[t.type.body, { color: t.color.inkStrong }]}>
              {LINKING_COPY.waiting}
            </Text>
            <Text
              style={[t.type.utilityData, { color: t.color.inkStrong }]}
              testID="link-expires"
            >
              {LINKING_COPY.expiresIn(
                clockFrom((phase.ceremony.expiresAt ?? 0) * 1000 - now),
              )}
            </Text>
            <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
              {LINKING_COPY.mismatchHint}
            </Text>
            <TextAction
              label={LINKING_COPY.stopWaiting}
              testID="link-stop-waiting"
              onPress={stopWaiting}
            />
            <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
              {LINKING_COPY.stopWaitingHint}
            </Text>
          </>
        )}

        {phase.name === 'linked' && (
          <>
            <Text style={[t.type.body, { color: t.color.inkStrong }]} testID="link-done">
              Linked. {LINKING_COPY.historyStance}
            </Text>
            <PrimaryButton label="Done" testID="link-done-button" onPress={onDone} />
          </>
        )}

        {phase.name === 'failed' && (
          <>
            <InlineError message={phase.message} testID="link-failed" />
            <TextAction
              label="Start again"
              testID="link-retry"
              onPress={() => setPhase({ name: 'scan', error: null })}
            />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { padding: 20, gap: 16 },
  groups: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'center',
  },
  group: { letterSpacing: 1 },
});
