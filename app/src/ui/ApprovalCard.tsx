import React, { useEffect, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  MAX_APPROVAL_PAYLOAD_BYTES,
  displayAiWorkTimestamp,
  type AiWorkMetadata,
} from '@tacendum/shared';
import type { ApprovalKind, ApprovalRow } from '../db';
import { clockLabel, dayLabel } from '../time';
import { hairline, useTheme, type Theme } from '../theme';
import { InfoDisclosure } from './InfoDisclosure';
import { PrimaryButton } from './primitives';

/**
 * The approval card — one machine asking one question.
 *
 * The screen owns the store, the clock tick and the send. The card owns its
 * disclosures and requires the exact request to be exposed before Approve
 * can call the injected handler; it never sends or settles anything itself.
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
const SETTLED_COPY: Record<
  Exclude<ApprovalDisplayState, 'answered'>,
  string
> = {
  pending: '', // unreachable through settledLine; listed so the Record is total
  lapsed: 'Lapsed — nothing was approved.',
};

/** The verbs this build can answer with. An unknown verb in the request's
 * `a` renders no button — never reads as approve, never reaches the wire. */
export const RECOGNISED_VERBS = ['approve', 'deny'] as const;

/** What this phone queued. It is deliberately not phrased as host execution. */
function queuedAnswer(verb: string | null): string {
  if (verb === 'approve') return 'Approve answer queued';
  if (verb === 'deny') return 'Deny answer queued';
  return `“${verb ?? ''}” answer queued`;
}

export const AI_PROVIDER_COPY: Record<AiWorkMetadata['provider'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor',
};

export const APPROVAL_OBSERVATION_COPY: Record<
  NonNullable<AiWorkMetadata['approvalObservation']>,
  (provider: string) => string
> = {
  'answer-received': () => 'The agent reports receiving a matching answer.',
  'decision-returned': provider =>
    `The agent reports returning the decision to ${provider}.`,
  'provider-received': provider =>
    `The agent reports ${provider} acknowledged the decision.`,
  expired: () => 'The agent reports this request expired.',
};

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
  if (
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      a.payload,
    )
  ) {
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

/** A convenience preview, never the authorization text. Only the Claude
 * permission wrapper emitted by our bridge has known command semantics.
 * Other JSON stays opaque; the full original is available in the review. */
function requestPreview(payload: string): {
  description?: string;
  command?: string;
} {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return {};
    const wrapper = parsed as Record<string, unknown>;
    if (
      typeof wrapper.tool_name !== 'string' ||
      typeof wrapper.cwd !== 'string'
    )
      return {};
    const input = wrapper.tool_input;
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      return {};
    const fields = input as Record<string, unknown>;
    return {
      ...(typeof fields.description === 'string' && fields.description.trim()
        ? { description: fields.description }
        : {}),
      ...(wrapper.tool_name === 'Bash' && typeof fields.command === 'string'
        ? { command: fields.command }
        : {}),
    };
  } catch {
    // Plain commands and diffs can be previewed, but only the disclosure
    // renders them as the exact selectable authorization text.
    return { command: payload };
  }
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
  const { fontScale } = useWindowDimensions();
  const actionMinimum = Math.max(96, Math.ceil(80 * fontScale));
  const styles = makeStyles(t);
  const state = approvalDisplayState(approval, now);
  const refusal = payloadRefusal(approval);
  const redacted = approval.payload === '' && state !== 'pending';
  const kindCopy = APPROVAL_KIND_COPY[approval.kind];
  // Defence in depth over the store's correlation rule. Supplementary facts
  // for a different request never render around these exact payload bytes.
  const work = approval.work?.requestId === approval.q ? approval.work : null;
  const provider = work ? AI_PROVIDER_COPY[work.provider] : null;
  const context = work?.context;
  const hostObservation = approval.hostObservation ?? null;
  const hostProvider = approval.hostObservationProvider
    ? AI_PROVIDER_COPY[approval.hostObservationProvider]
    : provider;

  // One button per declared verb, in the request's own order, recognised
  // ones only. When the payload is refused, `approve` drops out: what cannot
  // be shown exactly cannot be approved from here.
  const verbs = approval.verbs.filter(v =>
    (RECOGNISED_VERBS as readonly string[]).includes(v),
  );
  const offered = refusal === null ? verbs : verbs.filter(v => v !== 'approve');

  const settled = state !== 'pending' || hostObservation !== null;
  // Bind the open state to the exact row and bytes. A recycled list row or
  // changed payload must never inherit permission to approve from a review
  // of something else. Settling also returns the card to its compact receipt.
  const [review, setReview] = useState<{
    peerId: string;
    q: string;
    payload: string;
    settled: boolean;
  } | null>(null);
  const payloadOpen =
    review?.peerId === approval.peerId &&
    review.q === approval.q &&
    review.payload === approval.payload &&
    review.settled === settled;
  // Release the previous payload after redaction, replacement or settlement.
  // The equality guard above closes approval immediately, before this effect.
  useEffect(() => {
    setReview(null);
  }, [approval.peerId, approval.q, approval.payload, settled]);
  const [contextOpen, setContextOpen] = useState(false);
  const preview =
    refusal === null && !redacted ? requestPreview(approval.payload) : {};
  const answer = (verb: string) => {
    if (busy || settled || !offered.includes(verb)) return;
    if (verb === 'approve' && !payloadOpen) return;
    onAnswer(verb);
  };
  const settledLine =
    state === 'answered'
      ? `${queuedAnswer(approval.answerVerb)} · ${clockLabel(
          approval.settledAt ?? now,
        )} · saved here`
      : state === 'lapsed'
        ? SETTLED_COPY.lapsed
        : hostObservation !== null
          ? 'No answer is waiting on this device.'
          : '';

  return (
    <View
      {...(testID ? { testID } : {})}
      accessibilityLabel={`Approval — ${kindCopy.toLowerCase()}`}
      style={[styles.card, settled && styles.settled]}
    >
      <View style={styles.header}>
        {fontScale <= 1.5 ? (
          <View
            style={styles.mark}
            accessibilityElementsHidden
          >
            <Text
              allowFontScaling={false}
              style={[t.type.iconGlyph, { color: t.color.pine }]}
            >
              {approval.kind === 'exec'
                ? '›_'
                : approval.kind === 'file'
                  ? '≡'
                  : '?'}
            </Text>
          </View>
        ) : null}
        <View style={styles.titles}>
          <View style={styles.labelRow}>
            <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
              Approval
            </Text>
            {!settled ? (
              <Text
                style={[
                  t.type.compactBody,
                  styles.clock,
                  { color: t.color.warningInk },
                ]}
                testID={testID ? `${testID}-countdown` : undefined}
              >
                {countdownLabel(approvalDeadline(approval) - now)}
              </Text>
            ) : hostObservation !== null ? (
              <Text
                style={[
                  t.type.compactBody,
                  styles.clock,
                  { color: t.color.inkMuted },
                ]}
                testID={testID ? `${testID}-host-observed` : undefined}
              >
                Host updated
              </Text>
            ) : null}
          </View>
          <Text style={[t.type.sectionTitle, { color: t.color.inkStrong }]}>
            {kindCopy}
          </Text>
        </View>
      </View>

      {work || approval.sessionTag ? (
        <View style={styles.sourceStrip}>
          {work ? (
            <View
              style={styles.sourceIdentity}
              testID={testID ? `${testID}-source` : undefined}
            >
              <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
                {provider}
              </Text>
              {work.project ? (
                <Text
                  numberOfLines={1}
                  style={[
                    t.type.compactBody,
                    styles.sourceProject,
                    { color: t.color.inkMuted },
                  ]}
                >
                  {work.project}
                </Text>
              ) : null}
            </View>
          ) : null}
          {approval.sessionTag ? (
            <Text
              numberOfLines={1}
              style={[
                t.type.compactBody,
                styles.tagChip,
                { color: t.color.inkMuted },
              ]}
              testID={testID ? `${testID}-tag` : undefined}
            >
              {approval.sessionTag}
            </Text>
          ) : null}
        </View>
      ) : null}

      {(preview.description || preview.command) && !redacted ? (
        <View
          style={styles.preview}
          testID={testID ? `${testID}-preview` : undefined}
        >
          {preview.description ? (
            <Text
              numberOfLines={2}
              style={[t.type.body, { color: t.color.inkBody }]}
            >
              {preview.description}
            </Text>
          ) : null}
          {preview.command ? (
            <Text
              numberOfLines={settled ? 1 : 2}
              style={[t.type.utilityData, { color: t.color.inkMuted }]}
            >
              {preview.command}
            </Text>
          ) : null}
        </View>
      ) : null}

      {context && contextOpen ? (
        <View
          style={[styles.contextBox, { borderColor: t.color.lineSoft }]}
          testID={testID ? `${testID}-context` : undefined}
        >
          <Text style={[t.type.compactStrong, { color: t.color.inkMuted }]}>
            Agent context
          </Text>
          {context.availability === 'unavailable' ? (
            <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
              The agent could not capture repository or result context for this
              request.
            </Text>
          ) : (
            <>
              <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
                {(() => {
                  const shown = displayAiWorkTimestamp(
                    context.capturedAt,
                    approval.workReceivedAt ?? approval.arrivedAt,
                  );
                  const stamp = `${dayLabel(shown.at)} at ${clockLabel(shown.at)}`;
                  if (!shown.trusted) {
                    return `Received ${stamp} · source time untrusted. Repository state may have changed.`;
                  }
                  return context.availability === 'stale'
                    ? `The agent marked this context stale. Captured ${stamp}.`
                    : `Agent-reported capture · ${stamp}. Repository state may have changed since capture.`;
                })()}
              </Text>
              {context.repository ? (
                <View style={styles.factRow}>
                  <Text
                    style={[
                      t.type.compactStrong,
                      styles.factLabel,
                      { color: t.color.inkMuted },
                    ]}
                  >
                    Repository
                  </Text>
                  <Text
                    selectable
                    style={[
                      t.type.utilityData,
                      styles.factValue,
                      { color: t.color.inkBody },
                    ]}
                  >
                    {context.repository}
                  </Text>
                </View>
              ) : null}
              {context.branch ? (
                <View style={styles.factRow}>
                  <Text
                    style={[
                      t.type.compactStrong,
                      styles.factLabel,
                      { color: t.color.inkMuted },
                    ]}
                  >
                    Branch
                  </Text>
                  <Text
                    selectable
                    style={[
                      t.type.utilityData,
                      styles.factValue,
                      { color: t.color.inkBody },
                    ]}
                  >
                    {context.branch}
                  </Text>
                </View>
              ) : null}
              {context.resultSummary ? (
                <View style={styles.summary}>
                  <Text
                    style={[t.type.compactStrong, { color: t.color.inkMuted }]}
                  >
                    Agent-reported result
                  </Text>
                  <Text
                    selectable
                    style={[t.type.compactBody, { color: t.color.inkBody }]}
                  >
                    {context.resultSummary}
                  </Text>
                </View>
              ) : null}
            </>
          )}
        </View>
      ) : null}

      {refusal !== null ? (
        // THE REFUSAL, in place of the payload — a stated reason, never a
        // truncation. The sentence says why AND what that costs (no
        // approve); the machine's own copy of the payload is untouched.
        <View
          style={[styles.payloadBox, styles.payloadContent]}
          testID={testID ? `${testID}-refusal` : undefined}
        >
          <Text style={[t.type.compactBody, { color: t.color.warningInk }]}>
            {refusal}
          </Text>
        </View>
      ) : redacted ? (
        <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
          {`Cleared after settling · ${approval.payloadBytes} bytes`}
        </Text>
      ) : (
        <View style={styles.details}>
          <Pressable
            onPress={() =>
              setReview(
                payloadOpen
                  ? null
                  : {
                      peerId: approval.peerId,
                      q: approval.q,
                      payload: approval.payload,
                      settled,
                    },
              )
            }
            accessibilityRole="button"
            accessibilityLabel={
              payloadOpen ? 'Hide full request' : 'Review full request'
            }
            accessibilityHint={
              !settled
                ? 'Open the exact request text to enable Approve.'
                : undefined
            }
            accessibilityState={{ expanded: payloadOpen }}
            testID={testID ? `${testID}-details` : undefined}
            style={({ pressed }) => [
              styles.detailsToggle,
              pressed && { backgroundColor: t.color.pineWash },
            ]}
          >
            <View style={styles.detailLabels}>
              <Text style={[t.type.buttonCompact, { color: t.color.pine }]}>
                {payloadOpen
                  ? 'Full request'
                  : settled
                    ? 'View request'
                    : 'Review full request'}
              </Text>
              {!settled && !payloadOpen && offered.includes('approve') ? (
                <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
                  Required to approve
                </Text>
              ) : null}
            </View>
            <Text
              allowFontScaling={false}
              style={[t.type.iconGlyph, { color: t.color.inkMuted }]}
            >
              {payloadOpen ? '⌄' : '›'}
            </Text>
          </Pressable>
          {payloadOpen ? (
            // Only this block is authorization text: exact original bytes,
            // selectable and scrolling, with no trim, pretty-print or ellipsis.
            <ScrollView
              style={styles.payloadBox}
              contentContainerStyle={styles.payloadContent}
              nestedScrollEnabled
              testID={testID ? `${testID}-payload` : undefined}
            >
              <Text
                selectable
                style={[t.type.utilityData, { color: t.color.inkBody }]}
              >
                {approval.payload}
              </Text>
            </ScrollView>
          ) : null}
        </View>
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
                disabled={!payloadOpen}
                busy={busy}
                busyLabel="Approving…"
                onPress={() => answer(verb)}
                testID={testID ? `${testID}-approve` : undefined}
                style={[styles.actionButton, { minWidth: actionMinimum }]}
              />
            ) : (
              <Pressable
                key={verb}
                onPress={() => answer(verb)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Deny"
                accessibilityState={{ disabled: busy }}
                testID={testID ? `${testID}-deny` : undefined}
                style={({ pressed }) => [
                  styles.denyButton,
                  { minWidth: actionMinimum },
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

      {hostObservation !== null ? (
        <View
          style={styles.hostState}
          testID={testID ? `${testID}-host-state` : undefined}
        >
          <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
            {APPROVAL_OBSERVATION_COPY[hostObservation](
              hostProvider ?? 'the provider',
            )}
          </Text>
          <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
            Execution not confirmed.
          </Text>
        </View>
      ) : state === 'answered' ? (
        <Text
          style={[t.type.compactBody, { color: t.color.inkMuted }]}
          testID={testID ? `${testID}-host-waiting` : undefined}
        >
          Waiting for an update from the agent.
        </Text>
      ) : null}

      <View style={styles.footer}>
        {context ? (
          <Pressable
            onPress={() => setContextOpen(v => !v)}
            accessibilityRole="button"
            accessibilityLabel="Agent context"
            accessibilityState={{ expanded: contextOpen }}
            testID={testID ? `${testID}-context-toggle` : undefined}
            style={({ pressed }) => [
              styles.contextToggle,
              pressed && { backgroundColor: t.color.pineWash },
            ]}
          >
            <Text style={[t.type.buttonCompact, { color: t.color.inkMuted }]}>
              Agent context
            </Text>
            <Text
              allowFontScaling={false}
              style={[t.type.compactBody, { color: t.color.inkMuted }]}
            >
              {contextOpen ? '⌄' : '›'}
            </Text>
          </Pressable>
        ) : null}
        <InfoDisclosure
          label="About approval"
          lines={[
            'The preview and agent context are supplementary. Review the full original request before approving.',
            'These buttons send a word to your machine — nothing else travels.',
            'Your machine already holds the full request shown here.',
            'A queued answer is not proof that the operation ran.',
            'This does not confirm that the command or file change ran.',
          ]}
          testID={testID ? `${testID}-info` : undefined}
        />
      </View>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    card: {
      alignSelf: 'stretch',
      marginHorizontal: t.layout.gutter,
      marginVertical: t.space.s4,
      padding: t.space.s6,
      gap: t.space.s5,
      borderRadius: t.radius.bubble,
      borderWidth: 1,
      borderColor: t.color.pineLine,
      backgroundColor: t.color.paperSheet,
    },
    /** Settled reads quieter than live — and never colour alone: the
     * settled line says the word (the CallTile rule). The quiet is the
     * payload collapsing and the soft card outline, not a card-wide
     * opacity: 0.66 put the settled line at about 2.8:1, below the 4.5:1
     * AA floor. Use a recessed surface, never opacity. */
    settled: { borderColor: t.color.lineSoft },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.s5,
    },
    mark: {
      width: 44,
      height: 44,
      borderRadius: t.radius.button,
      borderWidth: hairline,
      borderColor: t.color.lineSoft,
      backgroundColor: t.color.paperSheet,
      alignItems: 'center',
      justifyContent: 'center',
    },
    titles: { flex: 1, gap: t.space.s1 },
    labelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: t.space.s2,
    },
    tagChip: {
      flexShrink: 1,
      paddingHorizontal: t.space.s3,
      paddingVertical: t.space.s1,
      borderRadius: t.radius.small,
      borderWidth: hairline,
      borderColor: t.color.lineSoft,
      backgroundColor: t.color.paperGround,
    },
    clock: { marginLeft: 'auto' },
    sourceStrip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.s4,
      flexWrap: 'wrap',
    },
    sourceIdentity: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.s4,
      flexShrink: 1,
    },
    sourceProject: { flexShrink: 1 },
    preview: { gap: t.space.s3 },
    details: { gap: t.space.s4 },
    detailsToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: t.space.s4,
      minHeight: t.layout.touchTarget,
      borderRadius: t.radius.small,
      paddingHorizontal: t.space.s5,
      paddingVertical: t.space.s4,
      borderWidth: hairline,
      borderColor: t.color.lineSoft,
      backgroundColor: 'transparent',
    },
    detailLabels: { flex: 1, gap: t.space.s1 },
    contextBox: {
      padding: t.space.s4,
      borderWidth: hairline,
      borderRadius: t.radius.tail,
      gap: t.space.s3,
    },
    factRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.space.s4,
    },
    factLabel: { width: 74 },
    factValue: { flex: 1 },
    summary: { gap: t.space.s1 },
    payloadBox: {
      maxHeight: 220,
      borderRadius: t.radius.small,
      borderWidth: hairline,
      borderColor: t.color.lineSoft,
      backgroundColor: t.color.paperGround,
    },
    payloadContent: { padding: t.space.s5 },
    hostState: {
      gap: t.space.s2,
    },
    footer: {
      borderTopWidth: hairline,
      borderTopColor: t.color.lineSoft,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      columnGap: t.space.s4,
    },
    contextToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.s4,
      minHeight: t.layout.touchTarget,
      borderRadius: t.radius.small,
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
      flexWrap: 'wrap',
      alignItems: 'stretch',
      gap: t.space.s5,
    },
    /** Balanced actions: each grows from a zero basis; Deny owns a safe
     * minimum so its label cannot be crushed by the primitive's width.
     * `flexBasis: 0` + `width: 'auto'` retire the primitive's full-bleed
     * width inside this row (the basis would otherwise BE 100%). */
    actionButton: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      width: 'auto',
      minWidth: 0,
    },
    /** Deny: a real button, destructive-outline. `flexShrink: 0` plus the
     * minWidth is the one-line guarantee — no row width can compress the
     * label below its own layout, so "Deny" can never wrap. */
    denyButton: {
      flexGrow: 1,
      flexShrink: 0,
      flexBasis: 0,
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
