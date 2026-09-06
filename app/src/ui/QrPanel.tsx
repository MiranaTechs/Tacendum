import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { DEVICE_NOUN } from '../deviceNoun';
import * as qr from '../qr';
import { themeTokens, useTheme } from '../theme';
import { usePaneWidth } from '../windowClass';
import { InlineError, TextAction } from './primitives';
import { shareWithAnchor } from './shareWithAnchor';

/**
 * Your own Tacendum ID, drawn as a picture you can hand over.
 *
 * There is no directory, so an ID only travels the way a phone number does —
 * one person gives it to another. The written 26 characters survive a phone
 * call; the picture survives a text message. Both are the same ID, and the
 * screen shows the written one first: this panel is the second reading of a
 * thing already on the page, never the only one.
 *
 * Mounted only while expanded, so the encode is lazy by construction and a
 * CoreImage failure can never degrade the screen every new chat starts from.
 */

const COPY = {
  helper: 'The picture holds your ID and nothing else.',
  share: 'Share as a picture',
  explainToggle: 'What this is',
  explain: [
    'This picture is your ID drawn as a QR code. There is no name in it, no phone number, and no link for a browser to open.',
    // The device is named in the
    // platform's own words via the token.
    `It is made on this ${DEVICE_NOUN} and Tacendum never sends it anywhere. Where it goes next is whatever you pick in the share sheet.`,
    'Anyone who has the picture can start a chat with you. Send it the way you would send your phone number — and a saved picture stays in Photos.',
  ],
  drawFailed: 'Tacendum couldn’t draw your QR code. Your ID above still works.',
  // The code itself is still on screen when this shows, so the sentence points
  // at the two things that do still work rather than at the written ID alone.
  shareFailed:
    'Tacendum couldn’t prepare the picture to send. You can still show this code on screen, or use the ID above.',
  imageLabel: 'QR code for your Tacendum ID',
  imageHint: 'Your ID in picture form. The same ID is written out above.',
} as const;

/**
 * The code's own ink and paper — the LIGHT palette, in both modes.
 *
 * A QR is a printed artefact, not a themed surface. Read from the dark
 * tokens these become #E9EFE9 on #1C221E: pale modules on a near-black quiet
 * zone, a contrast-inverted code. Both of this product's scanners are its own
 * and are inversion-blind (AVCaptureMetadataOutput; ZXing's
 * RGBLuminanceSource), and deep links are refused, so the system camera
 * cannot complete the exchange either — in dark mode the app's primary way of
 * adding a person simply stopped working. Printing the code on paper in both
 * modes is the on-brand answer, not a compromise: every scannable code in the
 * world looks like this.
 *
 * Module constants, not render values: they are the encode effect's deps, so
 * fixing them here is also what stops a theme flip from restarting a draw of
 * a code somebody is currently pointing a phone at.
 *
 * Measured on the light palette: inkStrong on paperSheet is 17.17:1. Pine —
 * this system's *action* colour — is 6.34:1, needlessly marginal for a cheap
 * decoder pointed at a recompressed screenshot at an angle, which is why the
 * ink is the strong one and not the brand one.
 */
const QR_DARK_HEX = themeTokens('light').color.inkStrong;
const QR_LIGHT_HEX = themeTokens('light').color.paperSheet;

/** The square the panel draws at, before the viewport gets a say. */
const QR_SIDE = 176;
/** Below this the code stops being scannable off a screen at all. */
const QR_SIDE_MIN = 120;

export function QrPanel({ id }: { id: string }) {
  const t = useTheme();
  // The PANE's width, never the window's: this panel
  // renders inside Profile/StartChat, which the wide shell puts in a pane —
  // the square sizes against the width it actually has. Compact answers
  // the window, as it always did (usePaneWidth's fallback).
  const width = usePaneWidth();
  const [drawn, setDrawn] = useState<qr.SelfQr | null>(null);
  /** The draw failed, so there is no picture — this one replaces the square. */
  const [error, setError] = useState<string | null>(null);
  /**
   * The picture drew fine but could not be put on disk for the share sheet.
   * A separate slot on purpose: hiding a QR that is currently being scanned
   * because a file write failed takes the panel's whole job away, and it never
   * came back — nothing re-runs the encode effect.
   */
  const [shareError, setShareError] = useState<string | null>(null);
  const [explain, setExplain] = useState(false);
  /** The share button, so the iPad popover points at it. */
  const shareAnchor = useRef<View>(null);

  // The ink is passed in from the module's own constants, never held by qr.ts
  // or the native module — see QR_DARK_HEX above for why they are the light
  // palette's and not this render's.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await qr.encodeSelfQr(id, {
          darkHex: QR_DARK_HEX,
          lightHex: QR_LIGHT_HEX,
        });
        if (cancelled) return;
        setDrawn(next);
        setError(null);
      } catch {
        // The class is the contract; the thrown text is never shown.
        if (cancelled) return;
        setError(COPY.drawFailed);
      }
    })();
    return () => {
      cancelled = true;
    };
    // The id alone: the ink is constant, so this runs once per person.
  }, [id]);

  // The share file goes when the panel does — not when Share.share resolves,
  // because AirDrop keeps reading it after the sheet dismisses. Unmount is the
  // first moment nothing can still want it, and it is also the moment the
  // person closed the picture.
  useEffect(
    () => () => {
      void qr.clearShareImage();
    },
    [],
  );

  const shareImage = useCallback(() => {
    if (drawn === null) return;
    // A retry that works must clear what the last one said.
    setShareError(null);
    void (async () => {
      try {
        const uri = await qr.writeShareImage(drawn.pngB64);
        // `url` only: a `message` alongside it makes iOS rank Safari above
        // Messages, and a caption would put the plaintext ID back into a
        // place that syncs.
        await shareWithAnchor({ url: uri }, shareAnchor);
      } catch (err) {
        // Dismissing the sheet rejects, and backing out is not a failure.
        if (err instanceof qr.QrShareFailed) setShareError(COPY.shareFailed);
      }
    })();
  }, [drawn]);

  // Geometry, not text: at a 3.1x accessibility size a scaled 176pt square is
  // wider than the viewport and unscannable. Every *word* in this panel still
  // scales.
  const side = Math.min(
    QR_SIDE,
    Math.max(QR_SIDE_MIN, width - 2 * t.layout.gutter - 2 * t.space.s8),
  );

  return (
    <View
      style={[
        styles.panel,
        {
          marginTop: t.space.s5,
          padding: t.space.s8,
          borderRadius: t.radius.drawer,
          backgroundColor: t.color.paperSheet,
          borderWidth: t.hairline,
          borderColor: t.color.lineSoft,
        },
      ]}
    >
      {error ? (
        // On paperSheet already; dangerWash on this surface measures under AA.
        <InlineError
          message={error}
          testID="self-qr-error"
          surface={t.color.paperSheet}
        />
      ) : drawn === null ? (
        // The square's space while CoreImage draws, so the panel does not jump
        // when the picture lands. Not an Image with an empty uri (iOS warns),
        // and nothing to announce yet.
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.image, { width: side, height: side }]}
        />
      ) : (
        <Image
          source={{ uri: drawn.dataUri }}
          resizeMode="contain"
          accessible
          accessibilityRole="image"
          // Deliberately not the spelled ULID: the same 26 characters are
          // spelled one swipe above, and labelling the picture with them makes
          // VoiceOver read the whole ID twice in a row.
          accessibilityLabel={COPY.imageLabel}
          accessibilityHint={COPY.imageHint}
          testID="self-qr-image"
          style={[styles.image, { width: side, height: side }]}
        />
      )}

      <Text
        style={[
          t.type.compactBody,
          { marginTop: t.space.s5, color: t.color.inkMuted },
        ]}
      >
        {COPY.helper}
      </Text>

      <View style={[styles.actions, { marginTop: t.space.s3 }]}>
        <TextAction
          ref={shareAnchor}
          label={COPY.share}
          onPress={shareImage}
          disabled={drawn === null}
          testID="share-self-qr"
        />
        <TextAction
          label={COPY.explainToggle}
          onPress={() => setExplain(open => !open)}
          testID="self-qr-explain"
        />
      </View>

      {shareError !== null ? (
        // Under the actions, never in place of the picture: the code on screen
        // is still perfectly scannable, and the failure is about the file the
        // share sheet wanted, not about the QR.
        <InlineError
          message={shareError}
          testID="self-qr-share-error"
          surface={t.color.paperSheet}
        />
      ) : null}

      {explain
        ? COPY.explain.map(line => (
            <Text
              key={line}
              style={[
                t.type.compactBody,
                styles.explainLine,
                { color: t.color.inkMuted },
              ]}
            >
              {line}
            </Text>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {},
  image: { alignSelf: 'center' },
  actions: { flexDirection: 'row' },
  explainLine: { marginTop: 8 },
});
