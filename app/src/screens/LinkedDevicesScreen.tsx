import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { shortId, spellId } from '../person';
import { useTheme } from '../theme';
import {
  InlineError,
  PrimaryButton,
  RuledLabel,
  ScreenHeader,
  TextAction,
} from '../ui/primitives';
import {
  currentRoster,
  LINKING_COPY,
  mutateRoster,
  onRecoveryNotice,
  onRosterChanged,
  reconcilePendingLink,
  redrivePendingMutations,
} from '../linking';
import * as accounts from '../accounts';
import { ACCOUNTS_COPY } from '../accountsCopy';
import * as db from '../db';
import type { LinkedDeviceRow, ProfileRow, RecoveryNoticeRow } from '../db';
import { DEVICE_CLASSES, type DeviceClass } from '@tacendum/shared';

/**
 * "Linked devices": the roster this device
 * holds, rendered from ceremony results and the server's fan-out notices —
 * the loud device-list discipline as a screen. Only members still IN the
 * group are listed: a revoked or unlinked device has disappeared from the
 * roster (its history row survives underneath, for event rendering).
 *
 * Per-device drill-down is first-class (the rule applied at home):
 * every row opens to its own detail with the two the design verbs — unlink
 * (amicable) and revoke (lost/stolen) — each behind its own consent-grade
 * confirmation, and the local-record disclosure states plainly that this
 * list is this device's own, never synced: a human act is not propagated.
 *
 * Every mutation is identity-SIGNED by this device (linking.mutateRoster →
 * native signLinkOp): a stolen bearer session alone can never edit this
 * screen's truth, and the server's epoch condition — not this UI — is the
 * authorization.
 */

type Detail =
  | { name: 'list' }
  | { name: 'device'; device: LinkedDeviceRow; confirm: 'unlink' | 'revoke' | null; busy: boolean; error: boolean };

export function LinkedDevicesScreen({
  profile,
  onBack,
  onLinkNew,
}: {
  profile: ProfileRow;
  onBack: () => void;
  onLinkNew: () => void;
}) {
  const t = useTheme();
  const [roster, setRoster] = useState<LinkedDeviceRow[] | null>(null);
  const [detail, setDetail] = useState<Detail>({ name: 'list' });
  /** The recovery lifecycle as this member device heard it:
   * requested carries the CANCEL
   * capability; cancelled/completed are the settled loudness. */
  const [recovery, setRecovery] = useState<RecoveryNoticeRow | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const refresh = useCallback(() => {
    void currentRoster()
      .then(rows => {
        if (mounted.current) setRoster(rows);
      })
      .catch(() => {
        if (mounted.current) setRoster([]);
      });
    void db
      .loadRecoveryNotice()
      .then(row => {
        if (mounted.current) setRecovery(row);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    // A submitted offer whose acceptance committed after the scan screen
    // unmounted: drive it to completion the moment this
    // surface opens, so the roster never renders a false "alone" sentence
    // over a server-side group. Success notifies the roster listener.
    void reconcilePendingLink().catch(() => undefined);
    // And the re-drive half: a signed roster mutation persisted
    // before a crash is re-driven byte-identical inside its own expiry —
    // the server's idempotent completion path finishes the teardown.
    void redrivePendingMutations().catch(() => undefined);
    const offRoster = onRosterChanged(refresh);
    const offRecovery = onRecoveryNotice(refresh);
    return () => {
      offRoster();
      offRecovery();
    };
  }, [refresh]);

  const cancelRecovery = useCallback(() => {
    setCancelBusy(true);
    setCancelFailed(false);
    void accounts
      .cancelRecovery()
      .then(outcome => {
        if (outcome !== 'ok') setCancelFailed(true);
      })
      .catch(() => setCancelFailed(true))
      .finally(() => {
        setCancelBusy(false);
        refresh();
      });
  }, [refresh]);

  /** When completion becomes possible, in a person's words. */
  const completesLabel = (completesAtSeconds: number): string =>
    new Date(completesAtSeconds * 1000).toLocaleString(undefined, {
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

  const runMutation = useCallback(
    (device: LinkedDeviceRow, op: 'unlink' | 'revoke') => {
      setDetail({ name: 'device', device, confirm: op, busy: true, error: false });
      void mutateRoster(op, { userId: device.userId, class: device.class })
        .then(() => {
          setDetail({ name: 'list' });
          refresh();
        })
        .catch(() => {
          setDetail({ name: 'device', device, confirm: null, busy: false, error: true });
          // The refusal path refreshes too (the linking module's stated
          // contract): a stale local row must not keep rendering as if the
          // refusal never happened.
          refresh();
        });
    },
    [refresh],
  );

  return (
    <View style={[styles.screen, { backgroundColor: t.color.paperGround }]}>
      <ScreenHeader
        title="Linked devices"
        onBack={detail.name === 'list' ? onBack : () => setDetail({ name: 'list' })}
        testIDBack="linked-devices-back"
      />
      <ScrollView contentContainerStyle={styles.body}>
        {detail.name === 'list' && (
          <>
            {/* THE RECOVERY LIFECYCLE, surfaced honestly: a
                pending recovery is a claim on THIS account's grouping, and
                the cancel — which WINS, at any moment inside the delay —
                belongs to every member device, this one included. */}
            {recovery?.kind === 'requested' && (
              <View testID="recovery-banner">
                <Text style={[t.type.body, { color: t.color.warningInk }]}>
                  {ACCOUNTS_COPY.noticeRequested(
                    // The slot word reaches glass only through the one
                    // chokepoint; a class the row somehow lacks falls back
                    // to the enum's first slot rather than spelling one.
                    LINKING_COPY.slotLabel((recovery.class ?? DEVICE_CLASSES[0]) as DeviceClass),
                    recovery.completesAt != null
                      ? completesLabel(recovery.completesAt)
                      : 'it completes',
                  )}
                </Text>
                {cancelFailed && (
                  <InlineError message={ACCOUNTS_COPY.noticeCancelFailed} />
                )}
                <PrimaryButton
                  label={ACCOUNTS_COPY.noticeCancelAction}
                  onPress={cancelRecovery}
                  disabled={cancelBusy}
                  testID="recovery-cancel"
                />
              </View>
            )}
            {recovery?.kind === 'cancelled' && (
              <Text
                style={[t.type.compactBody, { color: t.color.inkMuted }]}
                testID="recovery-cancelled"
              >
                {ACCOUNTS_COPY.noticeCancelled}
              </Text>
            )}
            {recovery?.kind === 'completed' && (
              <Text
                style={[t.type.body, { color: t.color.warningInk }]}
                testID="recovery-completed"
              >
                {ACCOUNTS_COPY.noticeCompleted(
                  LINKING_COPY.slotLabel((recovery.class ?? DEVICE_CLASSES[0]) as DeviceClass),
                )}
              </Text>
            )}
            {roster !== null && roster.length === 0 && (
              <Text style={[t.type.body, { color: t.color.inkMuted }]} testID="roster-empty">
                No linked devices. Your account lives on this device alone.
              </Text>
            )}
            {(roster ?? []).map(device => (
              <Pressable
                key={device.userId}
                testID={`linked-device-${device.userId}`}
                accessibilityRole="button"
                // Announced the way it is shown: the own device is
                // "This device", and the class reaches the label only
                // through the P3 slot-word chokepoint — never the raw
                // token.
                accessibilityLabel={`${
                  device.userId === profile.userId
                    ? 'This device'
                    : `Device ${shortId(device.userId)}`
                }, ${LINKING_COPY.slotLabel(device.class)}`}
                onPress={() =>
                  setDetail({
                    name: 'device',
                    device,
                    confirm: null,
                    busy: false,
                    error: false,
                  })
                }
                style={({ pressed }) => [
                  styles.row,
                  {
                    borderBottomColor: t.color.lineSoft,
                    borderBottomWidth: t.hairline,
                  },
                  pressed && { backgroundColor: t.color.pineWash },
                ]}
              >
                <Text style={[t.type.body, { color: t.color.inkStrong }]}>
                  {device.userId === profile.userId ? 'This device' : shortId(device.userId)}
                </Text>
                <Text style={[t.type.utilityData, { color: t.color.inkMuted }]}>
                  {LINKING_COPY.slotLabel(device.class)}
                </Text>
              </Pressable>
            ))}
            <PrimaryButton label="Link a device" testID="open-link-device" onPress={onLinkNew} />
          </>
        )}

        {detail.name === 'device' && (
          <>
            <RuledLabel label={LINKING_COPY.slotLabel(detail.device.class)} />
            <Text
              style={[t.type.utilityData, { color: t.color.inkStrong }]}
              accessibilityLabel={spellId(detail.device.userId)}
              testID="device-detail-id"
            >
              {detail.device.userId}
            </Text>
            <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
              {LINKING_COPY.verificationLocal}
            </Text>
            {detail.error && <InlineError message={LINKING_COPY.refused} />}
            {detail.confirm === null && (
              <>
                <TextAction
                  label={detail.device.userId === profile.userId ? 'Unlink this device' : 'Unlink'}
                  testID="device-unlink"
                  disabled={detail.busy}
                  onPress={() => setDetail({ ...detail, confirm: 'unlink', error: false })}
                />
                {detail.device.userId !== profile.userId && (
                  <TextAction
                    label="Lost or stolen — revoke"
                    testID="device-revoke"
                    disabled={detail.busy}
                    onPress={() => setDetail({ ...detail, confirm: 'revoke', error: false })}
                  />
                )}
              </>
            )}
            {detail.confirm === 'unlink' && !detail.busy && (
              <>
                <Text style={[t.type.body, { color: t.color.inkStrong }]}>
                  {LINKING_COPY.unlinkConfirm(
                    detail.device.userId === profile.userId
                      ? 'this device'
                      : shortId(detail.device.userId),
                  )}
                </Text>
                <PrimaryButton
                  label="Unlink"
                  testID="confirm-unlink"
                  onPress={() => runMutation(detail.device, 'unlink')}
                />
                <TextAction
                  label="Keep it linked"
                  testID="cancel-mutation"
                  onPress={() => setDetail({ ...detail, confirm: null })}
                />
              </>
            )}
            {detail.confirm === 'revoke' && !detail.busy && (
              <>
                <Text style={[t.type.body, { color: t.color.inkStrong }]}>
                  {LINKING_COPY.revokeConfirm(shortId(detail.device.userId))}
                </Text>
                <PrimaryButton
                  label="Revoke"
                  testID="confirm-revoke"
                  onPress={() => runMutation(detail.device, 'revoke')}
                />
                <TextAction
                  label="Keep it linked"
                  testID="cancel-mutation"
                  onPress={() => setDetail({ ...detail, confirm: null })}
                />
              </>
            )}
            {detail.busy && (
              <Text style={[t.type.body, { color: t.color.inkMuted }]}>Working…</Text>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { padding: 20, gap: 16 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
  },
});
