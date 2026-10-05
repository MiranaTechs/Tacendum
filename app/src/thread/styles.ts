// Conversation styles cached by theme. This module imports no screens, so
// rendering helpers can share the same stylesheet without reverse imports.
import { StyleSheet } from 'react-native';
import { type Theme } from '../theme';

/**
 * The thread's styles, per theme: spacing
 * from `t.space`, floors from `t.layout`, built once per token set and
 * shared by every component in this file. A WeakMap rather than a
 * per-component useMemo because MessageRowInner mounts by the dozen — one
 * StyleSheet per theme, never one per row. The token sets are module
 * constants in theme.ts, so the map holds at most two entries.
 *
 * Values that are SIZES — a 44pt floor, a 32pt arrow box, a 3pt rule — are
 * sizes, not spacing, and stay as they were (the floor is `t.layout`'s).
 * The 1pt optical nudges under a tick and a chip line stay literal too:
 * the scale has no 1, and 2 is not what the eye wanted there.
 */
/** The built sheet every component in the thread reads. */
export type ThreadStyles = ReturnType<typeof makeStyles>;

const stylesByTheme = new WeakMap<Theme, ThreadStyles>();
export function stylesFor(t: Theme): ThreadStyles {
  let s = stylesByTheme.get(t);
  if (!s) {
    s = makeStyles(t);
    stylesByTheme.set(t, s);
  }
  return s;
}

function makeStyles(t: Theme) {
  const { space, layout } = t;
  return StyleSheet.create({
    root: { flex: 1 },
    peerControl: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s5,
      minHeight: layout.touchTarget,
      flex: 1,
    },
    peerText: { flex: 1 },
    safetyControl: {
      width: 60,
      // 48 rather than the 44pt floor: the glyphs grew to 24, and a control
      // sized exactly at the minimum leaves a larger mark crowding its own
      // edges. Still a floor, not a fixed height, so Dynamic Type can push it
      // taller without clipping.
      minHeight: 48,
      alignItems: 'center',
      justifyContent: 'center',
    },
    safetyPanel: { paddingVertical: space.s6, borderBottomWidth: 1 },
    safetyTop: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    safetyClose: {
      minWidth: layout.touchTarget,
      minHeight: layout.touchTarget,
      alignItems: 'flex-end',
      justifyContent: 'center',
    },
    safetyStatusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: space.s5,
    },
    safetyStatusRule: {
      width: 3,
      alignSelf: 'stretch',
      minHeight: 15,
      marginRight: space.s5,
    },
    safetyGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: space.s4 },
    // A third of the row at default size; the group text is free to wrap
    // within it rather than being shrunk to fit.
    safetyCell: { width: '33.333%' },
    safetyHint: { marginTop: space.s4 },
    /** The panel's ⓘ, under the action row. */
    safetyAbout: { marginTop: space.s2 },
    safetyActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: space.s6,
    },
    textAction: {
      minHeight: layout.touchTarget,
      justifyContent: 'center',
      paddingHorizontal: space.s4,
      marginHorizontal: -space.s4,
    },
    listContent: { paddingHorizontal: layout.gutter, paddingBottom: space.s7 },
    emptyThread: {
      alignItems: 'center',
      marginTop: space.s7,
      marginBottom: space.s8,
    },
    emptyTitle: { marginTop: space.s7, textAlign: 'center' },
    emptyBody: { marginTop: space.s4, textAlign: 'center', maxWidth: 280 },
    bubble: {
      borderWidth: 1,
      flexDirection: 'row',
      alignItems: 'flex-end',
      justifyContent: 'center',
      gap: space.s3,
    },
    messageText: { flexShrink: 1 },
    /** A web address inside a bubble: underlined as well as inked, so the
     * affordance never rests on colour alone. */
    linkSpan: { textDecorationLine: 'underline' },
    /** An inbound content row: the bubble and its reply arrow on one line.
     * `alignItems: 'flex-end'` seats the arrow by the bubble's tail corner,
     * where the eye already reads "this message ends here". */
    replyRow: { flexDirection: 'row', alignItems: 'flex-end' },
    /** The bubble yields, the arrow never does: Yoga's flexShrink defaults to
     * 0, so without this a maximal bubble would push the fixed arrow box
     * toward the edge instead of letting its own text reflow. */
    bubbleShrink: { flexShrink: 1 },
    /** The reply arrow's disc. White on the white thread, so a hairline ring
     * is its edge; the colour is set where it is drawn. */
    replyArrow: {
      width: 28,
      height: 28,
      marginLeft: space.s3,
      marginBottom: 1,
      borderWidth: StyleSheet.hairlineWidth,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    /** The bubble is a row so the delivery tick sits beside the last line; a
     * quote, its answer and the edited mark stack inside this column. */
    bubbleBody: { flexShrink: 1 },
    quote: {
      borderLeftWidth: 2,
      paddingHorizontal: space.s4,
      paddingVertical: space.s2,
      marginBottom: space.s4,
    },
    /** Secondary text at FULL alpha: the palette owns the colour (inkMuted on
     * white, onBubbleOutMuted on forest) and the type role owns the emphasis.
     * The 0.75 opacity these carried put the inbound quote at ≈3.1:1 and the
     * edited mark at ≈3.7:1, under the 4.5:1 AA floor. */
    quoteText: {},
    /** The quoted author's name over their words. */
    quoteAuthor: { marginBottom: 0 },
    messageClock: { fontSize: 11, lineHeight: 15, fontVariant: ['tabular-nums'] },
    editedMark: { marginTop: space.s1 },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: 0,
      paddingLeft: space.s5,
      paddingRight: space.s3,
      paddingVertical: space.s4,
      overflow: 'hidden',
    },
    chipBar: {
      width: 2,
      borderRadius: 1,
      alignSelf: 'stretch',
      marginRight: space.s4,
    },
    chipBody: { flex: 1, flexShrink: 1 },
    chipText: { marginTop: 1 },
    chipCancel: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tombstone: {
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: space.s5,
      // 9, not a step: the bubble's own vertical padding, set inline where
      // the bubble is drawn — a tombstone stands in a bubble's place and
      // must be its height.
      paddingVertical: 9,
    },
    tombstoneText: { flexShrink: 1, fontStyle: 'italic' },
    /** The group gap — the same step a bubble opens a run with. */
    failedOut: { marginTop: space.s5 },
    failedBubble: { alignSelf: 'flex-end' },
    failedActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      alignItems: 'center',
      gap: space.s6,
    },
    statusGlyph: { marginBottom: 1 },
    photoStatus: {
      alignSelf: 'flex-end',
      marginTop: space.s2,
      marginRight: space.s2,
    },
    metaLeft: {
      alignSelf: 'flex-start',
      marginTop: space.s2,
      marginLeft: space.s2,
    },
    metaRight: {
      alignSelf: 'flex-end',
      marginTop: space.s2,
      marginRight: space.s2,
    },
    photoFallback: { alignItems: 'center', justifyContent: 'center' },
    photoFallbackText: { marginTop: space.s4 },
    photoRetry: {
      minHeight: layout.touchTarget,
      justifyContent: 'center',
      paddingHorizontal: space.s5,
    },
    reactionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s2, marginTop: space.s3 },
    reactionChip: {
      minHeight: 44,
      minWidth: 44,
      flexDirection: 'row',
      gap: space.s2,
      borderWidth: 1,
      paddingHorizontal: space.s3,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rail: {
      marginTop: space.s3,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.s5,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    railChoice: {
      width: layout.touchTarget,
      minHeight: layout.touchTarget,
      alignItems: 'center',
      justifyContent: 'center',
    },
    actionStrip: {
      minHeight: 40,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: space.s5,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    actionDetail: { flexShrink: 1, marginRight: space.s4 },
    actionButtons: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: space.s6,
    },
    /** One strip action: a 44pt minimum target with the word centred in it.
     * An 18pt line with 8pt of slop totals only 34pt and is too small. */
    actionButton: { minHeight: layout.touchTarget, justifyContent: 'center' },
    corruptRow: {
      marginVertical: space.s3,
      paddingHorizontal: space.s5,
      paddingVertical: space.s4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      alignItems: 'center',
    },
    corruptAction: { alignSelf: 'flex-end' },
    /** The event-row delivery notice: a breath under the event
     * sentence, centered with it by the corruptRow container. */
    eventNotice: { marginTop: space.s2 },
    /** The provenance line above a relayed row. Indented to the bubble it
     * annotates, so it reads as belonging to that message and not as a
     * standalone system notice. */
    sharedTag: {
      marginTop: space.s4,
      marginBottom: space.s1,
      marginHorizontal: space.s6,
    },
    /** An outsider's message: full width with a slate
     * accent bar — deliberately NOT the bubble shape, so it cannot be read as
     * a member speaking even with the tag line cropped. */
    outsiderRow: {
      marginVertical: space.s3,
      paddingHorizontal: space.s5,
      paddingVertical: space.s4,
      borderLeftWidth: 3,
      alignSelf: 'stretch',
    },
    outsiderText: { marginTop: space.s2 },
    /** The authenticated author over an inbound run's first bubble. */
    /** The line above a bubble: author label and/or the AI marker. A row so
     * the badge sits beside the name when both render; flex-start so an
     * unlabelled agent bubble's lone badge hugs the bubble's edge. */
    authorLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s3,
      alignSelf: 'flex-start',
      marginBottom: space.s1,
    },
    authorLabel: { marginLeft: space.s2, flexShrink: 1 },
    mismatchRow: {
      paddingVertical: space.s4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      alignItems: 'flex-start',
    },
    jumpRow: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: space.s4,
    },
    errorActions: {
      borderLeftWidth: 2,
      flexDirection: 'row',
      justifyContent: 'flex-end',
      alignItems: 'center',
      gap: space.s6,
    },
    /** "Preparing photo…": a white row on the white thread, edged top and
     * bottom by hairlines the way offlineRow is. */
    progressRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s4,
      paddingVertical: space.s4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    offlineRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s3,
      paddingVertical: space.s4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    offlineMark: { width: 6, height: 6 },
    offlineText: { flex: 1 },
    banner: {
      borderTopWidth: 2,
      borderLeftWidth: 3,
      paddingVertical: space.s5,
    },
    bannerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: space.s5 },
    bannerTitle: { flex: 1 },
    bannerBody: { marginTop: space.s3 },
    bannerActions: { flexDirection: 'row', gap: space.s5, marginTop: space.s5 },
    bannerButton: {
      minHeight: layout.touchTarget,
      borderWidth: 1,
      paddingHorizontal: space.s6,
      alignItems: 'center',
      justifyContent: 'center',
    },
    alertSquare: {
      width: 24,
      height: 24,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    composerWrap: {
      paddingTop: space.s4,
      paddingHorizontal: space.s5,
      paddingBottom: space.s4,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    counter: { textAlign: 'right', marginBottom: space.s2, marginRight: space.s2 },
    drawer: {
      borderWidth: 1,
      borderBottomWidth: 0,
      overflow: 'hidden',
      paddingTop: space.s6,
      paddingBottom: space.s5,
    },
    drawerSeam: { width: StyleSheet.hairlineWidth, height: '100%' },
    drawerGrid: { flexDirection: 'row', paddingHorizontal: space.s4 },
    drawerAction: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: space.s1,
      gap: space.s3,
    },
    drawerDisc: {
      width: 46,
      height: 46,
      borderRadius: 23,
      borderWidth: StyleSheet.hairlineWidth,
      alignItems: 'center',
      justifyContent: 'center',
    },
    drawerLabel: { textAlign: 'center' },
    /** The drawer's ⓘ, aligned with the grid's own gutter. */
    drawerAbout: { paddingHorizontal: space.s6, marginTop: space.s2 },
    voiceBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s5,
      paddingHorizontal: space.s5,
      paddingBottom: space.s3,
    },
    voiceLevelTrack: { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden' },
    voiceTrack: { height: 3, borderRadius: 2, overflow: 'hidden' },
    voiceTrackFill: { height: 3, borderRadius: 2 },
    voiceMetaRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: space.s4,
    },
    voiceLevelFill: { height: 4, borderRadius: 2 },
    emojiRow: { paddingHorizontal: space.s4, alignItems: 'center' },
    emojiChoice: {
      width: layout.touchTarget,
      minHeight: layout.touchTarget,
      alignItems: 'center',
      justifyContent: 'center',
    },
    /** The member picker: list padding replaces the drawer's grid padding. */
    mentionDrawer: { paddingTop: space.s3, paddingBottom: space.s2 },
    /** One person: a circle and a name. minHeight (never height) so scaled
     * text grows the row — the no-clipping rule the room header tests pin. */
    mentionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s5,
      paddingHorizontal: space.s6,
      paddingVertical: space.s2,
    },
    mentionName: { flexShrink: 1 },
    mentionChipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: space.s3,
      paddingHorizontal: space.s2,
      paddingBottom: space.s3,
    },
    mentionChip: {
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: 1,
      paddingLeft: space.s5,
      minHeight: 32,
    },
    mentionChipCancel: {
      minWidth: 32,
      minHeight: 32,
      alignItems: 'center',
      justifyContent: 'center',
    },
    /** A mention in a bubble: weight beside the '@' glyph — the ink is the
     * theme's, applied inline, and never the only signal. */
    mentionSpan: { fontWeight: '600' },
    composer: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      borderWidth: 1,
      minHeight: layout.buttonHeight,
      paddingHorizontal: space.s2,
    },
    composerIcon: {
      width: layout.touchTarget,
      height: layout.touchTarget,
      alignItems: 'center',
      justifyContent: 'center',
    },
    composerInput: {
      flex: 1,
      minHeight: layout.touchTarget,
      maxHeight: 110,
      // 11: tuned with the input's 21pt line to meet the 44pt floor exactly
      // — sizing, not spacing.
      paddingVertical: 11,
    },
    sendDisc: {
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}
