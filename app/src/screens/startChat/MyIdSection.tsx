import React, { useCallback, useEffect, useRef } from 'react';
import {
  // Deprecated in core but still shipped (the trade this screen made before
  // this file existed): the whole point of an ID is that it gets pasted.
  Clipboard,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { shareIdMessage } from '../../peerId';
import { spellId } from '../../person';
import { groupIdLines } from '../../reachClassifier';
import { useTheme } from '../../theme';
import { InfoDisclosure } from '../../ui/InfoDisclosure';
import { QrPanel } from '../../ui/QrPanel';
import { InlineNotice, OutlineButton } from '../../ui/primitives';
import { shareWithAnchor } from '../../ui/shareWithAnchor';
import { useTransientNotice } from '../../ui/useTransientNotice';
import { ChevronGlyph, CopyGlyph, ShareGlyph } from './glyphs';

/**
 * "My ID": your own ID and QR code, one tap away under a hairline, collapsed
 * on every visit — this screen is for reaching THEM. One tap shows the ID in
 * large mono type (four groups, a break, three: the lines the other person
 * compares against), Copy ID, Share ID and the QR code, which is encoded only
 * then.
 *
 * Never "code" for your own identifier: the App Lock passcode and the duress
 * code are "your code", and "share your code" is the classic social-
 * engineering line. Share sends the ID as a message only — a link would put
 * it where browsers open, log and sync it.
 *
 * Screen readers get two stops in the header, the heading and the chevron:
 * the row around them is pressable for a finger but is not itself an
 * accessibility element (Pressable is focusable by default on Android, so
 * that is switched off too).
 */

export interface MyIdCopy {
  title: string;
  subtitle: string;
  show: string;
  hide: string;
  ownIdHint: string;
  copyId: string;
  shareId: string;
  copied: string;
  infoLabel: string;
  info: readonly string[];
}

export function MyIdSection({
  id,
  open,
  onToggle,
  copy,
  onSectionLayout,
}: {
  id: string;
  open: boolean;
  onToggle: () => void;
  copy: MyIdCopy;
  /** The section's top within its parent, for the screen's scroll-to. */
  onSectionLayout?: (y: number) => void;
}): React.JSX.Element {
  const t = useTheme();
  const { fontScale } = useWindowDimensions();
  // Below the first iOS accessibility size, so the two buttons stack before
  // their labels have to wrap (the IdentityRow threshold).
  const stacked = fontScale > 1.35;
  const { notice, seq, show, clear } = useTransientNotice(3000);
  /** The Share button, so the iPad popover points at it. */
  const shareAnchor = useRef<View>(null);

  // A confirmation belongs to the section it confirms: closing takes it away.
  useEffect(() => {
    if (!open) clear();
  }, [open, clear]);

  const copySelfId = useCallback(() => {
    // The bare ID and no pasteboard expiry: an ID is an address, not a
    // secret — the whole point is that it gets pasted.
    Clipboard.setString(id);
    show(copy.copied);
  }, [id, show, copy.copied]);

  const shareSelfId = useCallback(() => {
    void (async () => {
      try {
        // `message` only: a `url` makes iOS rank Safari above Messages, and
        // this ID is meant for one person, not a post.
        await shareWithAnchor({ message: shareIdMessage(id) }, shareAnchor);
      } catch {
        // Dismissing the sheet is not a failure.
      }
    })();
  }, [id]);

  const layOut = useCallback(
    (event: LayoutChangeEvent) => onSectionLayout?.(event.nativeEvent.layout.y),
    [onSectionLayout],
  );

  return (
    <View
      testID="my-id-section"
      onLayout={layOut}
      style={[styles.section, { borderTopWidth: t.hairline, borderTopColor: t.color.lineSoft }]}
    >
      <Pressable
        testID="my-id-row"
        onPress={onToggle}
        accessible={false}
        focusable={false}
        importantForAccessibility="no"
        style={styles.header}
      >
        <View style={styles.titles}>
          <Text
            testID="my-id-title"
            accessibilityRole="header"
            style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
          >
            {copy.title}
          </Text>
          <Text style={[t.type.compactBody, styles.subtitle, { color: t.color.inkMuted }]}>
            {copy.subtitle}
          </Text>
        </View>
        <Pressable
          testID="show-self-id"
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityLabel={open ? copy.hide : copy.show}
          accessibilityState={{ expanded: open }}
          style={({ pressed }) => [
            styles.chevron,
            {
              minWidth: t.layout.touchTarget,
              minHeight: t.layout.touchTarget,
              borderRadius: t.radius.button,
            },
            pressed && { backgroundColor: t.color.pineWash },
          ]}
        >
          <ChevronGlyph up={open} color={t.color.inkMuted} />
        </Pressable>
      </Pressable>
      {open ? (
        <>
          <Text
            selectable
            testID="self-user-id"
            accessibilityLabel={spellId(id)}
            accessibilityHint={copy.ownIdHint}
            maxFontSizeMultiplier={2}
            style={[styles.ownId, { fontFamily: t.mono, color: t.color.inkStrong }]}
          >
            {groupIdLines(id)}
          </Text>
          <View
            testID="my-id-actions"
            style={[styles.actions, stacked ? styles.actionsStacked : styles.actionsRow]}
          >
            <OutlineButton
              testID="copy-self-id"
              label={copy.copyId}
              leading={<CopyGlyph color={t.color.pine} />}
              onPress={copySelfId}
              style={stacked ? undefined : styles.actionInRow}
            />
            <View
              ref={shareAnchor}
              collapsable={false}
              style={stacked ? undefined : styles.actionInRow}
            >
              <OutlineButton
                testID="share-self-id"
                label={copy.shareId}
                leading={<ShareGlyph color={t.color.pine} />}
                onPress={shareSelfId}
              />
            </View>
          </View>
          {notice ? (
            <InlineNotice tone="pine" message={notice} seq={seq} testID="self-id-copied" />
          ) : null}
          <View style={styles.info}>
            <InfoDisclosure label={copy.infoLabel} lines={copy.info} testID="my-id-info" />
          </View>
          {/* Mounted only while open, so the QR is encoded on request. */}
          <QrPanel id={id} />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 20 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 72,
    paddingTop: 14,
    paddingBottom: 12,
  },
  titles: { flex: 1 },
  subtitle: { marginTop: 2 },
  // Keeps the glyph optically on the gutter despite its own hit area.
  chevron: { alignItems: 'center', justifyContent: 'center', marginRight: -10 },
  // Mono 22/30: large enough to read out four characters at a time.
  ownId: { fontSize: 22, lineHeight: 30, fontWeight: '400', letterSpacing: 0.3, marginTop: 2 },
  actions: { marginTop: 16, gap: 12 },
  actionsRow: { flexDirection: 'row' },
  actionsStacked: { flexDirection: 'column' },
  actionInRow: { flex: 1 },
  info: { marginTop: 4 },
});
