import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ROUND_COPY } from '../rounds';
import { hairline, useTheme, type Theme } from '../theme';

/**
 * The FULL ANSWER behind a tap, inside the bubble and under the words
 * (§3.2).
 *
 * A round answer is a BRIEF and a DETAIL written by one model, in one
 * message, under one ratchet-authenticated sender: the brief is the words the
 * bubble already shows, and the detail is the rest of the same message.
 * Nothing splits them and nothing recombines them — this control reveals a
 * field that arrived, and claims nothing else. It is never called a summary
 * (§2): the brief is the model's own, and on the fail-open path it is a
 * clipped first paragraph, so "summary" would claim a reading that never
 * happened.
 *
 * A NEW COMPONENT, not a widened `InfoDisclosure`. It takes that one's
 * ANATOMY — glyph, label, `accessibilityState={{ expanded }}`, the sentences
 * appearing in place rather than in a floating sheet — and nothing else:
 * `InfoDisclosure` is documented as deliberately actionless with plain-string
 * teaching lines, and a disclosure that carries a payload someone else wrote
 * has stopped being teaching copy. The BODY is `ApprovalCard`'s payload
 * block instead: a recessed box, selectable monospace-capable runs, and a
 * height cap that SCROLLS rather than truncating, because a detail that
 * silently lost its tail would be a different answer than the one sent.
 *
 * Deliberately stateless. `expanded` is held by the screen, keyed by
 * `${msgId}:${direction}`, so it survives this row's re-memo and the thread's
 * next requery — a disclosure that closed itself on every receipt would be
 * unusable in a live room.
 *
 * VoiceOver reaches this through the BUBBLE's `accessibilityAction`, not
 * through the button below: the bubble is one accessibility element, which
 * flattens a nested control out of the tree entirely (the `reveal` / `link:i`
 * precedent in ChatThreadScreen). The button is still labelled and still
 * carries its expanded state, for TalkBack and for anything that does reach
 * it.
 */
export function DetailDisclosure({
  detail,
  expanded,
  onToggle,
  out,
  msgId,
}: {
  /** The full answer, exactly as it arrived — already capped and normalised
   * on the composing side (`@tacendum/shared/rounds:capDetail`). Never
   * trimmed, ellipsised or re-wrapped here. */
  detail: string;
  expanded: boolean;
  onToggle: () => void;
  /** An outbound bubble: the ink and the recessed surface flip to the
   * on-pine pair, exactly as the quote box inside the same bubble does. */
  out: boolean;
  /** The row's msgId — the ONE prop both testIDs derive from (§3.9), so the
   * toggle and the body can never be named for different rows. */
  msgId: string;
}) {
  const t = useTheme();
  const styles = stylesFor(t);
  const ink = out ? t.color.onBubbleOut : t.color.pine;
  const label = expanded ? ROUND_COPY.hideDetail : ROUND_COPY.showDetail;
  return (
    <View style={styles.wrap}>
      <Pressable
        testID={`detail-${msgId}`}
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded }}
        // ~45pt effective vertically without a 44pt box inside a bubble:
        // 17pt of label line + 2×8pt padding = 33pt of real box, plus 6pt of
        // slop each way that the WRAP pads for. RN hitSlop never extends
        // past the parent view (ChoiceRow.tsx:25 records the same rule and
        // the same remedy), so slop with no parent room is slop that does
        // not exist — the earlier 21pt box with 10pt of unbounded slop was
        // a 21pt target claiming to be 44.
        hitSlop={{ top: 6, bottom: 6, left: 10, right: 10 }}
        style={({ pressed }) => [
          styles.toggle,
          {
            borderRadius: t.radius.small,
            backgroundColor: pressed
              ? out
                ? t.color.bubbleOutPressed
                : t.color.pineWash
              : 'transparent',
          },
        ]}
      >
        <Text
          // The glyph must not reflow the label at Dynamic Type XXL; the
          // label beside it scales, which is what carries the meaning.
          allowFontScaling={false}
          style={[t.type.iconGlyph, { color: ink }]}
        >
          {expanded ? '▾' : '▸'}
        </Text>
        <Text style={[t.type.buttonCompact, { color: ink }]}>{label}</Text>
      </Pressable>
      {expanded ? (
        <ScrollView
          testID={`detail-body-${msgId}`}
          nestedScrollEnabled
          style={[
            styles.box,
            {
              borderRadius: t.radius.tail,
              borderColor: out ? t.color.onBubbleOut : t.color.lineStrong,
              backgroundColor: out
                ? t.color.bubbleOutPressed
                : t.color.paperInset,
            },
          ]}
        >
          <Text
            selectable
            style={[
              t.type.utilityData,
              { color: out ? t.color.onBubbleOut : t.color.inkBody },
            ]}
          >
            {detail}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

function stylesFor(t: Theme) {
  return StyleSheet.create({
    /** Vertical padding HERE (not only on the control) so the toggle's
     * hitSlop has parent bounds to land in — RN hitSlop never extends past
     * the parent view (ChoiceRow.tsx:25). The negative bottom margin gives
     * that room back to the layout, so the bubble does not grow. */
    wrap: {
      alignSelf: 'stretch',
      paddingVertical: t.space.s3,
      marginBottom: -t.space.s3,
    },
    toggle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      paddingHorizontal: 6,
      marginHorizontal: -6,
      paddingVertical: 8,
    },
    /** The payload block: recessed, capped, and scrolling INSIDE — never
     * truncating (ApprovalCard's `payloadBox`, at a bubble's scale). */
    box: {
      marginTop: t.space.s3,
      maxHeight: 220,
      padding: t.space.s4,
      borderWidth: hairline,
    },
  });
}
