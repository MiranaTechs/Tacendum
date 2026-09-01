import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { safetyGroups } from '../safety';
import { shortId } from '../person';
import { useTheme } from '../theme';
import {
  InlineError,
  PrimaryButton,
  RuledLabel,
  ScreenHeader,
  TextAction,
} from '../ui/primitives';
import { AcceptorCeremony, LINKING_COPY, NoVerificationCodeError } from '../linking';
import type { ProfileRow } from '../db';

/**
 * The NEW-device confirm surface: who is
 * asking, the SAME verification code the existing device shows — derived
 * independently from both identity public keys — and the two honest exits.
 * The person compares the two screens; a substituted or reused self-QR
 * makes the codes disagree and the ceremony dies visibly right here. A
 * code that cannot be derived at all is a hard refusal, never a blank
 * region with a live confirm button.
 *
 * A lived-in device never reaches the code: `AcceptorCeremony.open`
 * answers 'not_pristine' and this screen says so plainly instead of
 * rendering a confirmation that can only fail (client half).
 * An offer naming a slot class this device is not answers
 * 'class_mismatch' the same way — the acceptance signature asserts the
 * class about THIS device, and what it will assert is DISPLAYED above the
 * confirm.
 *
 * The history stance is stated BEFORE the confirm, verbatim
 * (`LINKING_COPY.historyStance`, a pinned sentence).
 */

type Phase =
  | { name: 'loading' }
  | { name: 'none' }
  | { name: 'notPristine' }
  | { name: 'classMismatch' }
  | { name: 'noCode' }
  | { name: 'code'; ceremony: AcceptorCeremony; busy: boolean }
  | { name: 'linked' }
  | { name: 'failed' };

export function LinkConfirmScreen({
  profile: _profile,
  onClose,
}: {
  profile: ProfileRow;
  onClose: () => void;
}) {
  const t = useTheme();
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });

  useEffect(() => {
    let mounted = true;
    void AcceptorCeremony.open()
      .then(opened => {
        if (!mounted) return;
        if (opened === null) setPhase({ name: 'none' });
        else if (opened === 'not_pristine') setPhase({ name: 'notPristine' });
        else if (opened === 'class_mismatch') setPhase({ name: 'classMismatch' });
        else setPhase({ name: 'code', ceremony: opened, busy: false });
      })
      .catch(error => {
        if (!mounted) return;
        setPhase(
          error instanceof NoVerificationCodeError ? { name: 'noCode' } : { name: 'failed' },
        );
      });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <View style={[styles.screen, { backgroundColor: t.color.paperGround }]}>
      <ScreenHeader title="Link this device" onBack={onClose} testIDBack="link-confirm-back" />
      <ScrollView contentContainerStyle={styles.body}>
        {phase.name === 'loading' && (
          <Text style={[t.type.body, { color: t.color.inkMuted }]}>Checking…</Text>
        )}

        {phase.name === 'none' && (
          <>
            <Text style={[t.type.body, { color: t.color.inkStrong }]}>
              There is no link request waiting. Link requests expire after a few
              minutes — start again from the other device.
            </Text>
            <PrimaryButton label="Close" testID="link-confirm-close" onPress={onClose} />
          </>
        )}

        {phase.name === 'notPristine' && (
          <>
            <Text style={[t.type.body, { color: t.color.inkStrong }]} testID="link-not-pristine">
              {LINKING_COPY.notPristine}
            </Text>
            <PrimaryButton label="Close" testID="link-confirm-close" onPress={onClose} />
          </>
        )}

        {phase.name === 'classMismatch' && (
          <>
            <Text style={[t.type.body, { color: t.color.inkStrong }]} testID="link-class-mismatch">
              {LINKING_COPY.classMismatch}
            </Text>
            <PrimaryButton label="Close" testID="link-confirm-close" onPress={onClose} />
          </>
        )}

        {phase.name === 'noCode' && (
          <>
            <Text style={[t.type.body, { color: t.color.inkStrong }]} testID="link-no-code">
              {LINKING_COPY.noCode}
            </Text>
            <PrimaryButton label="Close" testID="link-confirm-close" onPress={onClose} />
          </>
        )}

        {phase.name === 'code' && (
          <>
            <Text style={[t.type.body, { color: t.color.inkStrong }]}>
              {LINKING_COPY.codeInstructionNew(shortId(phase.ceremony.offer.offererUserId))}
            </Text>
            <RuledLabel label="Verification code" />
            <View style={styles.groups} testID="link-confirm-code-groups">
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
            <Text style={[t.type.compactBody, { color: t.color.inkMuted }]} testID="link-slot-assertion">
              {LINKING_COPY.slotAssertion(
                LINKING_COPY.slotLabel(phase.ceremony.offer.acceptorClass),
              )}
            </Text>
            <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
              {LINKING_COPY.historyStance}
            </Text>
            <PrimaryButton
              label="The codes match — link"
              testID="link-accept"
              disabled={phase.busy}
              onPress={() => {
                if (phase.busy) return;
                setPhase({ ...phase, busy: true });
                void phase.ceremony
                  .accept()
                  .then(() => setPhase({ name: 'linked' }))
                  .catch(() => setPhase({ name: 'failed' }));
              }}
            />
            <TextAction
              label="They don’t match"
              testID="link-decline"
              onPress={() => {
                void phase.ceremony.decline().finally(onClose);
              }}
            />
          </>
        )}

        {phase.name === 'linked' && (
          <>
            <Text style={[t.type.body, { color: t.color.inkStrong }]} testID="link-confirm-done">
              Linked. {LINKING_COPY.historyStance}
            </Text>
            <PrimaryButton label="Done" testID="link-confirm-done-button" onPress={onClose} />
          </>
        )}

        {phase.name === 'failed' && (
          <>
            <InlineError message={LINKING_COPY.refused} />
            <PrimaryButton label="Close" testID="link-confirm-close" onPress={onClose} />
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
