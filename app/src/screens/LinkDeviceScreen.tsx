import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import * as qr from '../qr';
import { DEVICE_SLOT_CLASSES, type DeviceSlotClass } from '../deviceNoun';
import { PickCancelled, pickImageFile } from '../media';
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

type Phase =
  | { name: 'scan'; error: string | null }
  | { name: 'starting' }
  | { name: 'code'; ceremony: OffererCeremony; klass: DeviceSlotClass; busy: boolean }
  | { name: 'waiting'; ceremony: OffererCeremony }
  | { name: 'linked' }
  | { name: 'failed' };

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
    async (read: () => Promise<string>) => {
      setPhase({ name: 'starting' });
      try {
        const scannedId = await read();
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
        if (!mounted.current) return;
        const message =
          error instanceof qr.QrNoCode || error instanceof PickCancelled
            ? null // cancelled camera/picker or nothing found: back to the intro
            : error instanceof qr.QrOwnId
              ? 'That is this device’s own code — scan the NEW device’s code.'
              : error instanceof qr.QrNotAnId || error instanceof qr.QrAmbiguous
                ? 'That code isn’t a Tacendum ID.'
                : error instanceof NoVerificationCodeError
                  ? LINKING_COPY.noCode
                  : LINKING_COPY.refused;
        setPhase({ name: 'scan', error: message });
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
            else if (phase.ceremony.phase === 'failed') setPhase({ name: 'failed' });
            else schedule();
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

  const confirm = useCallback(() => {
    if (phase.name !== 'code' || phase.busy) return;
    setPhase({ ...phase, busy: true });
    void phase.ceremony
      .confirm(phase.klass)
      .then(() => {
        if (mounted.current) setPhase({ name: 'waiting', ceremony: phase.ceremony });
      })
      .catch(() => {
        if (mounted.current) setPhase({ name: 'failed' });
      });
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
            {phase.error !== null && <InlineError message={phase.error} />}
            <PrimaryButton
              label="Scan with camera"
              testID="link-scan-camera"
              onPress={() => void beginFrom(() => qr.readIdFromCamera(profile.userId))}
            />
            <TextAction
              label="Choose a photo of the code"
              testID="link-scan-photo"
              onPress={() =>
                void beginFrom(async () => {
                  const file = await pickImageFile('library');
                  return qr.readIdFromImage(file.uri, profile.userId);
                })
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
            <InlineError message={LINKING_COPY.refused} />
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
