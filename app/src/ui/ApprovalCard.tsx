import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MAX_APPROVAL_PAYLOAD_BYTES } from '@tacendum/shared';
import type { ApprovalKind, ApprovalRow } from '../db';
import { DEVICE_NOUN } from '../deviceNoun';
import { clockLabel } from '../time';
import { hairline, useTheme, type Theme } from '../theme';
import { InfoDisclosure } from './InfoDisclosure';
import { PrimaryButton } from './primitives';

/**
 * The approval card — one machine asking one question.
 *
 * A pure function of one stored `approvals` row plus injected callbacks, the
 * `CallTile` discipline: it reads nothing, subscribes to nothing and decides
 * nothing. The screen owns the store, the clock tick and the send; the card
 * owns only what is honest to SAY.
 *
 * Three rules do the real work, and each is asserted rather than trusted:
 *
 *  1. VERBATIM OR REFUSE. The payload block renders the exact bytes
 *     the machine will run — monospace, selectable, no markdown pass, no
 *     trimming, no ellipsis; long content scrolls INSIDE the block. A payload
 *     this card cannot show byte-exactly (over the wire cap, or holding a
 *     lone surrogate the renderer would substitute) is REFUSED with a stated
 *     reason, and refusing to show it also refuses to approve it: approving
 *     unseen bytes is the one thing this surface exists to prevent. Deny
 *     stays available — denying what you cannot read is always honest.
 *  2. THE COUNTDOWN IS A CLOCK READING, NEVER STATE. `now` arrives as a prop
 *     (the screen ticks once a second); the deadline derives from the stored
 *     row. Expiry is decided on the CLI's clock as `deny, via:'ttl'` — the
 *     local grey-out claims only what this phone did, which is nothing:
 *     "Lapsed — nothing was approved." can never contradict the machine's
 *     own deny-by-timeout sentence.
 *  3. ONLY THE DECLARED VERBS, AND ONLY THE RECOGNISED ONES. One button per
 *     verb in the request's `a`, intersected with what this build knows; an
 *     unknown verb renders no button and can never be sent back as an answer
 *     it would not survive. Approve and deny are never colour alone.
 *
 * States are a total Record — a new state is a compile error here, not an
 * empty card on someone's screen (the CallTile precedent).
 */

/** What each request family is called — fixed copy, never sender text. */
export const APPROVAL_KIND_COPY: Record<ApprovalKind, string> = {
  exec: 'Run a command',
  file: 'Change files',
  other: 'Requested action',
};

/** What the card can be showing. `lapsed` covers both the stored state and a
 * pending row whose local deadline has passed — same words either way. */
export type ApprovalDisplayState = 'pending' | 'answered' | 'lapsed';

/** The settled sentences. Total by type: a new state must bring its copy. */
const SETTLED_COPY: Record<Exclude<ApprovalDisplayState, 'answered'>, string> = {
  pending: '', // unreachable through settledLine; listed so the Record is total
  lapsed: 'Lapsed — nothing was approved.',
};

/** The verbs this build can answer with. An unknown verb in the request's
 * `a` renders no button — never reads as approve, never reaches the wire. */
export const RECOGNISED_VERBS = ['approve', 'deny'] as const;

/** The receipt's verb word. Past tense because the receipt is a record of an
 * act, not a control; the fallback quotes the stored verb rather than
 * guessing at its grammar. */
function receiptVerb(verb: string | null): string {
  if (verb === 'approve') return 'Approved';
  if (verb === 'deny') return 'Denied';
  return `Answered “${verb ?? ''}”`;
}

/** The local deadline — display only; expiry is decided on the CLI's clock. */
export function approvalDeadline(a: ApprovalRow): number {
  return a.arrivedAt + a.ttlSec * 1000;
}

/** The stored state, corrected by the clock: a pending row past its local
 * deadline SHOWS as lapsed even before the store's read-time maintenance
 * writes it down. Derived, so removing the screen's tick leaves the card
 * truthful — just less prompt. */
export function approvalDisplayState(
  a: ApprovalRow,
  now: number,
): ApprovalDisplayState {
  if (a.state === 'pending' && now >= approvalDeadline(a)) return 'lapsed';
  return a.state;
}

/**
 * Why this card will not render the payload, or null when it will.
 *
 * Two conditions, both about byte-fidelity rather than taste:
 *  - over the wire cap: the schema refuses such a frame, so a row holding
 *    one was written by something other than this build's parse — refuse
 *    rather than trust it, and NEVER truncate (a truncated command is a
 *    different command);
 *  - a lone surrogate: React Native's renderer substitutes U+FFFD for it,
 *    so what the screen showed would not be what the machine runs — the
 *    markdown-degradation lesson in its renderer-shaped form.
 */
export function payloadRefusal(a: ApprovalRow): string | null {
  if (a.payload.length > MAX_APPROVAL_PAYLOAD_BYTES) {
    return 'This request is too large to show exactly, so it cannot be approved from here.';
  }
  // A high surrogate not followed by a low one, or a low one not preceded by
  // a high one — either renders as a substitute character, not the byte.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(a.payload)) {
    return 'This request contains text that cannot be shown exactly, so it cannot be approved from here.';
  }
  return null;
}

/** m:ss under an hour, h:mm:ss over — never negative. Display only. */
export function countdownLabel(msLeft: number): string {
  const total = Math.max(0, Math.floor(msLeft / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)} left` : `${m}:${two(s)} left`;
}

export function ApprovalCard({
  approval,
  now,
  onAnswer,
  busy = false,
  testID,
}: {
  approval: ApprovalRow;
  /** The screen's once-a-second clock reading. */
  now: number;
  /** Answer with one recognised, declared verb. The screen sends the reply
   * and settles the store; the card only asks. */
  onAnswer: (verb: string) => void;
  /** True while an answer is in flight — the buttons hold still until the
   * outbox row exists. */
  busy?: boolean;
  testID?: string;
}): React.JSX.Element {
  const t = useTheme();
  const styles = makeStyles(t);
  const state = approvalDisplayState(approval, now);
  const refusal = payloadRefusal(approval);
  const redacted = approval.payload === '' && state !== 'pending';
  const kindCopy = APPROVAL_KIND_COPY[approval.kind];

  // One button per declared verb, in the request's own order, recognised
  // ones only. When the payload is refused, `approve` drops out: what cannot
  // be shown exactly cannot be approved from here.
  const verbs = approval.verbs.filter(v =>
    (RECOGNISED_VERBS as readonly string[]).includes(v),
  );
  const offered = refusal === null ? verbs : verbs.filter(v => v !== 'approve');

  const settled = state !== 'pending';
  const settledLine =
    state === 'answered'
      ? `${receiptVerb(approval.answerVerb)} · ${clockLabel(
          approval.settledAt ?? now,
        )} · from this ${DEVICE_NOUN}`
      : state === 'lapsed'
        ? SETTLED_COPY.lapsed
        : '';

  return (
    <View
      {...(testID ? { testID } : {})}
      accessibilityLabel={`Approval — ${kindCopy.toLowerCase()}`}
      style={[styles.card, settled && styles.settled]}
    >
      <View style={styles.header}>
        <Text style={[t.type.utilityLabel, { color: t.color.pine }]}>
          APPROVAL
        </Text>
        <Text style={[t.type.compactStrong, styles.kind, { color: t.color.inkStrong }]}>
          {kindCopy}
        </Text>
        {approval.sessionTag ? (
          <View style={styles.tagChip} testID={testID ? `${testID}-tag` : undefined}>
            <Text style={[t.type.utilityData, { color: t.color.inkMuted }]}>
              {approval.sessionTag}
            </Text>
          </View>
        ) : null}
        {state === 'pending' ? (
          <Text
            style={[t.type.timeStatus, styles.clock, { color: t.color.warningInk }]}
            testID={testID ? `${testID}-countdown` : undefined}
          >
            {countdownLabel(approvalDeadline(approval) - now)}
          </Text>
        ) : null}
      </View>

      {refusal !== null ? (
        // THE REFUSAL, in place of the payload — a stated reason, never a
        // truncation. The sentence says why AND what that costs (no
        // approve); the machine's own copy of the payload is untouched.
        <View style={styles.payloadBox} testID={testID ? `${testID}-refusal` : undefined}>
          <Text style={[t.type.compactBody, { color: t.color.warningInk }]}>
            {refusal}
          </Text>
        </View>
      ) : redacted ? (
        <View style={styles.payloadBox}>
          <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
            {`Cleared after settling · ${approval.payloadBytes} bytes`}
          </Text>
        </View>
      ) : (
        // THE FEATURE: the exact bytes, monospace, selectable, scrolling
        // INSIDE the block — no markdown pass, no trimming, no ellipsis.
        <ScrollView
          style={styles.payloadBox}
          nestedScrollEnabled
          testID={testID ? `${testID}-payload` : undefined}
        >
          <Text selectable style={[t.type.utilityData, { color: t.color.inkBody }]}>
            {approval.payload}
          </Text>
        </ScrollView>
      )}

      {settled ? (
        <Text
          style={[t.type.compactStrong, { color: t.color.inkMuted }]}
          testID={testID ? `${testID}-settled` : undefined}
        >
          {settledLine}
        </Text>
      ) : (
        <View style={styles.actions}>
          {offered.map(verb =>
            verb === 'approve' ? (
              <PrimaryButton
                key={verb}
                label="Approve"
                busy={busy}
                busyLabel="Approving…"
                onPress={() => onAnswer(verb)}
                testID={testID ? `${testID}-approve` : undefined}
                style={styles.actionButton}
              />
            ) : (
              <Pressable
                key={verb}
                onPress={() => onAnswer(verb)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Deny"
                accessibilityState={{ disabled: busy }}
                testID={testID ? `${testID}-deny` : undefined}
                style={({ pressed }) => [
                  styles.denyButton,
                  // Alone in the row (a refused payload, or a request that
                  // declared no approve), Deny takes the width Approve
                  // would have held — a lone content-width pill would read
                  // as an afterthought on its own card.
                  !offered.includes('approve') && styles.denyAlone,
                  {
                    backgroundColor: pressed
                      ? t.color.dangerWash
                      : 'transparent',
                  },
                ]}
              >
                <Text style={[t.type.button, { color: t.color.danger }]}>
                  Deny
                </Text>
              </Pressable>
            ),
          )}
        </View>
      )}

      <InfoDisclosure
        label="What approving does"
        lines={[
          'These buttons send a word to your machine — nothing else travels.',
          'Your machine runs only the exact text shown here, which it already holds.',
          'If the timer runs out, nothing runs.',
        ]}
        testID={testID ? `${testID}-info` : undefined}
      />
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    card: {
      alignSelf: 'stretch',
      marginHorizontal: t.layout.gutter,
      marginVertical: t.space.s4,
      padding: t.space.s5,
      gap: t.space.s5,
      borderRadius: t.radius.drawer,
      borderWidth: 1,
      borderColor: t.color.lineSoft,
      backgroundColor: t.color.paperLayer,
    },
    /** Settled reads quieter than live — and never colour alone: the
     * settled line says the word (the CallTile rule). */
    settled: { opacity: 0.66 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.s4,
      flexWrap: 'wrap',
    },
    kind: { flexShrink: 1 },
    tagChip: {
      paddingHorizontal: t.space.s3,
      paddingVertical: t.space.s1,
      borderRadius: t.radius.small,
      backgroundColor: t.color.paperInset,
      borderWidth: hairline,
      borderColor: t.color.lineSoft,
    },
    clock: { marginLeft: 'auto' },
    payloadBox: {
      maxHeight: 220,
      padding: t.space.s5,
      borderRadius: t.radius.tail,
      borderWidth: hairline,
      borderColor: t.color.lineStrong,
      backgroundColor: t.color.paperInset,
    },
    /**
     * The button row, on the call-actions anatomy (IncomingCallScreen):
     * a row with a gap, children stretched to one shared height, and every
     * child owning a real minimum instead of fighting flex for survival.
     *
     * Found on a device (build 9): PrimaryButton's base style carries
     * `width: '100%'` — full-bleed by design, correct everywhere it stands
     * alone. Inside this row that width became Approve's flex BASIS, so
     * shrink resolution handed Approve nearly everything and crushed Deny
     * below its own label ("Deny" wrapping character by character). The row
     * now states each side's flex contract explicitly.
     */
    actions: {
      flexDirection: 'row',
      alignItems: 'stretch',
      gap: t.space.s5,
    },
    /** Approve: prominent — it grows into all width Deny does not need.
     * `flexBasis: 0` + `width: 'auto'` retire the primitive's full-bleed
     * width inside this row (the basis would otherwise BE 100%). */
    actionButton: { flexGrow: 1, flexShrink: 1, flexBasis: 0, width: 'auto', minWidth: 0 },
    /** Deny: a real button, destructive-outline. `flexShrink: 0` plus the
     * minWidth is the one-line guarantee — no row width can compress the
     * label below its own layout, so "Deny" can never wrap. */
    denyButton: {
      flexGrow: 0,
      flexShrink: 0,
      minWidth: 96,
      minHeight: t.layout.buttonHeight,
      paddingHorizontal: t.space.s6,
      borderRadius: t.radius.button,
      borderWidth: 1,
      borderColor: t.color.danger,
      alignItems: 'center',
      justifyContent: 'center',
    },
    /** A Deny with no Approve beside it spans the row (grow, never shrink). */
    denyAlone: { flexGrow: 1 },
  });
}
