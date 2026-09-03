import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  BackHandler,
  findNodeHandle,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiRequestError } from '../api';
import type { ProfileRow } from '../db';
import { DEVICE_NOUN } from '../deviceNoun';
import { PHONE_UI_ENABLED } from '../phoneUi';
import { createOrRestoreAccount } from '../registration';
import { USERNAME_UI_ENABLED } from '../usernameUi';
import { useTheme, type Theme } from '../theme';
import { BrandLockup } from '../ui/BrandMark';
import {
  DashedPhoneGlyph,
  IfLostDiagram,
  KeyFlowDiagram,
  KeyGlyph,
  NoTypingGlyph,
  ReachingYouDiagram,
  SplitKeyGlyph,
} from '../ui/IdentityDiagrams';
import { IdentityHero } from '../ui/IdentityHero';
import { InfoDisclosure } from '../ui/InfoDisclosure';
import {
  InlineError,
  PrimaryButton,
  RuledLabel,
  ScreenHeader,
  TextAction,
} from '../ui/primitives';
import { useReduceMotion } from '../useReduceMotion';
import { usePaneWidth } from '../windowClass';
import { PRIVACY_URL, TERMS_URL } from '../version';

interface Props {
  onRegistered: (profile: ProfileRow) => void;
  onBack: () => void;
}

/**
 * Every visible string, in one place — verbatim from the identity-redesign
 * mockup, with ONE recorded amendment: the
 * two "only way anyone reaches you" sentences gained the consent-gated
 * findability clause deliberately (the
 * product carries opt-in find-by-email, and the phone class joins under
 * the build pin, so an unconditional "only way" would ship false in the
 * same release that flips the declarations; the correction is scoped to
 * the classes THIS binary can actually link, via `OPTIONAL_REACH`).
 *
 * THE RECOVERY SENTENCE IS STILL THE POINT OF THIS SCREEN
 * (cost table row 3), and the redesign makes the
 * person SAY SO before the button will fire: the agreement sentence sits in
 * its own consent card, the checkbox that carries it arms the button, and the
 * confirm sheet restates the two consequences one last time before the key is
 * made. Restates, never introduces — both sheet rows compress copy already on
 * the main screen.
 *
 * Said plainly and without alarm — no warning icon, no danger colour. Nothing
 * has gone wrong; this is how the product works, and a screen that flinches
 * while saying so teaches people to skip it.
 */

/** The identifier classes a person could LATER link and consent to be found
 * by — the one fragment the reach sentences interpolate. Follows the build pin, so a false-pin binary never names the
 * phone class its declarations do not carry (the four-surfaces rule), and
 * the pin-ON binary tells the whole truth in its own release. */
const OPTIONAL_REACH = PHONE_UI_ENABLED ? 'an email or phone number' : 'an email';

/** The username class rides the same rule under ITS pin (the pin-flip
 * build): a parenthetical after the linkable classes, so a
 * pin-OFF binary's sentence is byte-identical to the one it shipped before,
 * and the pin-ON binary names every class a person can actually be found by. */
const OPTIONAL_HANDLE = USERNAME_UI_ENABLED ? ', or choose a username,' : '';

const COPY = {
  eyebrow: 'YOUR IDENTITY',
  title: 'Create your identity',
  // Every sentence that names the device
  // speaks the platform's language via `DEVICE_NOUN` — same facts, same
  // consent, per device. On an iPhone every rendering is the mockup's
  // sentence, verbatim.
  lead: `No account to set up. Your identity is a key — and this ${DEVICE_NOUN} is about to make it for you.`,
  /** Three facts: glyph + bold one-liner + teaching copy behind ⓘ. */
  facts: [
    {
      line: `A key, made on this ${DEVICE_NOUN}`,
      infoLabel: 'How the key signs you in',
      infoLines: [
        'The key is the whole account. To sign you in it signs a one-time number from our server — no password exists to steal, guess, or reset.',
      ],
      testID: 'register-info-key',
    },
    {
      line: 'Nothing to type, nothing to remember',
      infoLabel: 'How people reach you',
      infoLines: [
        `There is no directory and no contact upload. You hand someone your ID as a QR code or 26 written characters — and unless you later link ${OPTIONAL_REACH}${OPTIONAL_HANDLE} in Settings and switch on findability, that is the only way anyone can reach you.`,
      ],
      testID: 'register-info-reach',
    },
    {
      line: 'The private half never leaves',
      infoLabel: 'What our server receives',
      infoLines: [
        `The public half of your key, plus one-time keys that let people reach you while this ${DEVICE_NOUN} is offline. No phone number, no email, no name, nothing from your contacts.`,
      ],
      testID: 'register-info-server',
    },
  ],
  // The consent moment. App Store 5.1.1(ii) wants consent for collection, and
  // the honest version here is a sentence the person has actively agreed to —
  // the checkbox is the arming action, not decoration.
  consentLabel: 'BEFORE YOU CREATE IT',
  agree: `I understand: if I lose this ${DEVICE_NOUN}, my identity can’t be recovered — not even by Tacendum.`,
  noRecoveryLabel: 'Why there is no recovery',
  noRecoveryLines: [
    'Any door that could restore an identity would also open for whoever asked convincingly enough.',
    `If this ${DEVICE_NOUN} is lost or wiped, you would create a fresh identity and the people you talk to would add you again.`,
    'What comes next: encrypted backups that only you hold the key to.',
  ],
  create: 'Create my identity',
  creating: 'Creating your identity…',
  explainToggle: 'How this works',
  /** The three ruled rows behind the toggle: label + diagram + paragraph. */
  hiw: [
    {
      label: 'THE KEY',
      body: `The key is made here and the private half never leaves this ${DEVICE_NOUN}. Proving who you are means signing a one-time number from the server — which is why there is no password to steal, guess, or reset.`,
    },
    {
      label: 'REACHING YOU',
      body: `Your identity needs no phone number and no email, so there is no directory to look you up in and no contact list to upload. You hand your ID to someone as a QR code or as 26 written characters — unless you later link ${OPTIONAL_REACH}${OPTIONAL_HANDLE} and choose to be findable by it, that is the only way anyone reaches you.`,
    },
    {
      label: `IF THIS ${DEVICE_NOUN.toUpperCase()} IS LOST`,
      body: `A lost ${DEVICE_NOUN} is final: any door that could restore an identity would also open for whoever asked convincingly enough. Instead of a recovery desk, what comes next is encrypted backups that only you hold the key to.`,
    },
  ],
  /** The confirm sheet: it restates, never introduces. Both labels stay — the
   * card's and this overline. */
  sheetOverline: 'BEFORE YOUR KEY IS MADE',
  sheetTitle: 'Two things worth knowing',
  sheetRows: [
    {
      head: `This ${DEVICE_NOUN} is the only place your identity lives.`,
      body: 'If it is lost or wiped, nobody can restore the identity — not even us. You would start fresh, and the people you know would add you again.',
    },
    {
      head: 'Only the public half of your key leaves.',
      body: 'It goes to our server, along with the one-time keys that let people reach you — no phone number, no email, no name attached. The private half stays here.',
    },
  ],
  notYet: 'Not yet',
  /** The links themselves. Reachable in-app, which is what 5.1.1(i) asks for
   * and what the About section in Settings also provides. */
  privacyLink: 'Privacy policy',
  termsLink: 'Terms',
  // Backend detail never reaches this screen. There is exactly one thing a
  // person can do about any failure here, and it is "try again", so the copy
  // says that rather than naming which of keygen, challenge, signature, auth
  // or key upload gave out.
  failed:
    'Tacendum couldn’t finish setting up your identity. Check your connection and try again.',
  rateLimited: 'Too many tries. Wait a minute, then try again.',
  // The one failure where "try again" would be a lie. The identity key is
  // gone — a restore to a new device brings the chats but deliberately not
  // the key — and nothing can bring it back, so the copy says what is true
  // instead of pointing at the connection. Ships unchanged — out of the
  // redesign's scope.
  identityLost:
    `This ${DEVICE_NOUN} no longer has the identity key these conversations belong to. ` +
    `The key never leaves the ${DEVICE_NOUN} it was made on and can’t be restored — ` +
    'not from a backup, and not by us. Your messages here are safe to read, ' +
    'but this identity can’t send or receive. To keep talking, you’d start a ' +
    'fresh identity and the people you know would add you again.',
} as const;

function failureMessage(err: unknown): string {
  // Terminal, not transient: retrying cannot ever work, and the generic copy
  // ("check your connection") would send someone in circles over a state that
  // is final by design. Matched on the error NAME rather than the class —
  // instanceof breaks whenever the module is mocked or duplicated by the
  // bundler, and a match that silently degrades to the "try again" copy is
  // exactly the failure this branch exists to prevent. The mismatch case is
  // folded in: it is the same fact worded from the other side.
  const errorName = (err as { name?: string } | null)?.name;
  if (errorName === 'IdentityLostError' || errorName === 'AccountMismatchError') {
    return COPY.identityLost;
  }
  // The per-IP auth bucket is the only abuse control left once identities are
  // free to mint (cost table row 2), so being throttled is an ordinary
  // outcome worth naming — waiting actually fixes it, unlike everything else.
  if (err instanceof ApiRequestError && err.code === 'rate_limited') {
    return COPY.rateLimited;
  }
  return COPY.failed;
}

/**
 * One screen, one action — now with the consent said out loud. There is no
 * phone field, no code field and no PIN step, because there is no phone
 * number, no SMS and no registration lock — the keypair is the account.
 *
 * The flow: the checkbox arms the button; the button presents an in-tree
 * confirm sheet (the app's first hovering surface, kept honest — a scrim and
 * a paperLayer slab, no RN Modal, no shadow); the sheet's own button performs
 * the one create call and routes into the app.
 */
export function RegisterScreen({ onRegistered, onBack }: Props) {
  const t = useTheme();
  // The PANE's width. Register is a full-window route at
  // every width (a pinned fact), so this answers the window today — the point
  // is that content sizing reads the pane axis, uniformly, everywhere. The
  // sheet's slide math below keeps its WINDOW height read: panes span the
  // window's full height.
  const width = usePaneWidth();
  const gutter =
    width <= t.layout.narrowWidth ? t.layout.gutterNarrow : t.layout.gutterWide;
  const reduceMotion = useReduceMotion();
  const insets = useSafeAreaInsets();

  const [agreed, setAgreed] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped per failure so an identical repeated message is re-announced. */
  const [errorSeq, setErrorSeq] = useState(0);

  /** Where VoiceOver returns when the sheet dismisses: the Create button's
   * own Pressable — a real accessibility element, not a wrapper the
   * traversal would skip and VoiceOver would ignore. */
  const createButtonRef = useRef<View>(null);
  /** Set by dismissSheet, consumed by the effect below: the focus move must
   * land AFTER the dismissal commits, never while the modal host still owns
   * the VoiceOver order. */
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (sheet || !restoreFocus.current) return;
    restoreFocus.current = false;
    const tag = findNodeHandle(createButtonRef.current);
    if (tag != null) AccessibilityInfo.setAccessibilityFocus(tag);
  }, [sheet]);

  /** Ticked = pine fill + onPine ✓, landing on one 140ms beat. */
  const tick = useRef(new Animated.Value(0)).current;
  const toggleAgree = () => {
    const next = !agreed;
    setAgreed(next);
    if (reduceMotion) {
      tick.setValue(next ? 1 : 0);
      return;
    }
    Animated.timing(tick, {
      toValue: next ? 1 : 0,
      duration: t.motion.micro,
      easing: t.motion.easing,
      useNativeDriver: true,
    }).start();
  };

  /**
   * "How this works", the QrPanel idiom: expand in place, never a screen or a
   * sheet. `open` is the target state (and the chevron's); `mounted` keeps the
   * rows in the tree until the collapse finishes reversing.
   */
  const [explainOpen, setExplainOpen] = useState(false);
  const [explainMounted, setExplainMounted] = useState(false);
  // JS-driven on purpose: the collapse needs its completion callback to
  // unmount the rows, and the mocked native driver never delivers one.
  const reveal = useRef(new Animated.Value(0)).current;
  const toggleExplain = () => {
    if (!explainOpen) {
      setExplainOpen(true);
      setExplainMounted(true);
      if (reduceMotion) {
        reveal.setValue(1);
        return;
      }
      Animated.timing(reveal, {
        toValue: 1,
        duration: t.motion.surface,
        easing: t.motion.easing,
        useNativeDriver: false,
      }).start();
      return;
    }
    setExplainOpen(false);
    if (reduceMotion) {
      reveal.setValue(0);
      setExplainMounted(false);
      return;
    }
    Animated.timing(reveal, {
      toValue: 0,
      duration: t.motion.surface,
      easing: t.motion.easing,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished) setExplainMounted(false);
    });
  };
  const chevronTurn = reveal.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '90deg'],
  });

  // A running timing keeps its own timer — BrandMark's lesson. Left alive
  // past this screen, a mid-flight tick or reveal ticks against a torn-down
  // tree.
  useEffect(
    () => () => {
      tick.stopAnimation();
      reveal.stopAnimation();
    },
    [tick, reveal],
  );

  /**
   * Open a policy page. Silent on failure, same reasoning as the Settings
   * About rows: these are reference links, the URLs are compile-time
   * constants, and the only realistic failure is a device with no https
   * handler — where an error banner on the sign-up screen would do nothing
   * but scare someone off a page they were reading voluntarily.
   */
  const openPolicy = async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      // Intentionally silent — see above.
    }
  };

  const presentSheet = () => {
    // The disabled Pressable already refuses; this guard is the same rule for
    // anything that reaches the handler another way.
    if (!agreed || busy) return;
    setError(null);
    setSheet(true);
  };

  const dismissSheet = () => {
    // Mid-flight there is nothing safe to walk away to: the create call is
    // running and its answer needs a surface to land on.
    if (busy) return;
    // Nothing lost: the checkbox stays ticked, and VoiceOver goes back to the
    // button it left from — once the dismissal has committed (the effect on
    // `sheet` above), not while the modal view is still mounted.
    restoreFocus.current = true;
    setSheet(false);
  };

  /** The re-entrancy gate. React state alone cannot stop a second activation
   * in the same event batch — both presses read busy=false before any flush —
   * so the ref is the guard and the state only drives the UI. */
  const busyRef = useRef(false);
  /** Whether this screen is still in the tree: the create call can outlive
   * it (an edge swipe mid-flight), and its answer must not touch the state
   * of a screen that is gone. */
  const mounted = useRef(true);
  useEffect(() => {
    // Hardware back (Android) while the create call is in flight: the sheet
    // already refuses its scrim and "Not yet" mid-flight, and the system
    // button has to refuse the same way — otherwise the app router pops to
    // landing, the call resolves against a torn-down screen, and
    // `onRegistered` teleports the person in from nowhere. RN asks the most
    // recent subscriber first and stops at the first `true`, so this answers
    // before the router's own handler; idle, it yields (`false`) and the
    // router pops as it always did. The REF is read, not the state — a tap
    // can land before the state has flushed.
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => busyRef.current,
    );
    return () => {
      mounted.current = false;
      subscription.remove();
    };
  }, []);
  const create = async () => {
    // `agreed` is re-checked here, not only at presentation: if the consent
    // checkbox has been untoggled while the sheet is up (the VoiceOver-leak
    // path), the consent that legally arms this flow is false at the moment
    // the key would be made.
    if (busyRef.current || !agreed) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      // Keygen, challenge, signature, auth and the key upload all live behind
      // this one press; any of them failing means there is no usable identity
      // yet, which is what the copy says. A duress session refuses inside
      // createOrRestoreAccount before any of it runs and
      // surfaces here as an ordinary failure, which is the whole idea.
      onRegistered(await createOrRestoreAccount());
    } catch (err) {
      // A failure landing after the screen is gone has no surface to land
      // on: the next visit starts clean.
      if (!mounted.current) return;
      setError(failureMessage(err));
      setErrorSeq(seq => seq + 1);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: t.color.paperGround }]}>
      <ScreenHeader
        title={<BrandLockup size={15} />}
        onBack={onBack}
        backLabel="Back"
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingHorizontal: gutter },
        ]}
      >
        <View style={[styles.page, { maxWidth: t.layout.contentMax }]}>
          <IdentityHero reduceMotion={reduceMotion} />

          <Text
            style={[t.type.utilityLabel, styles.eyebrow, { color: t.color.pine }]}
          >
            {COPY.eyebrow}
          </Text>
          <Text
            accessibilityRole="header"
            style={[
              t.type.screenTitle,
              styles.title,
              { color: t.color.inkStrong },
            ]}
          >
            {COPY.title}
          </Text>
          <Text
            style={[t.type.body, styles.paragraph, { color: t.color.inkBody }]}
          >
            {COPY.lead}
          </Text>

          {/* Three facts: glyph + bold one-liner + ⓘ. All ship closed. */}
          <View style={styles.facts}>
            {COPY.facts.map((fact, i) => (
              <View key={fact.line} style={styles.fact}>
                <Tile t={t}>
                  {i === 0 ? (
                    <KeyGlyph />
                  ) : i === 1 ? (
                    <NoTypingGlyph />
                  ) : (
                    <SplitKeyGlyph />
                  )}
                </Tile>
                <View style={styles.factTxt}>
                  <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
                    {fact.line}
                  </Text>
                  <InfoDisclosure
                    label={fact.infoLabel}
                    lines={fact.infoLines}
                    testID={fact.testID}
                  />
                </View>
              </View>
            ))}
          </View>

          {/* The consent moment gets its own surface: checkbox and its ⓘ on
              one paperSheet card, so checkbox-arms-button reads as one unit. */}
          <RuledLabel label={COPY.consentLabel} marginTop={24} marginBottom={14} />
          <View
            style={[
              styles.consentCard,
              {
                backgroundColor: t.color.paperSheet,
                borderColor: t.color.lineSoft,
                borderWidth: t.hairline,
                borderRadius: t.radius.drawer,
              },
            ]}
          >
            <Pressable
              onPress={toggleAgree}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: agreed }}
              accessibilityLabel={COPY.agree}
              testID="register-consent"
              // The CallPicker anatomy this row cites keeps a 56pt row floor;
              // here the floor is the 44pt target — without it, two wrapped
              // 21pt lines put the screen's one legally load-bearing control
              // under the minimum.
              style={[styles.agreeRow, { minHeight: t.layout.touchTarget }]}
            >
              <View
                style={[
                  styles.checkbox,
                  {
                    borderColor: agreed ? t.color.pine : t.color.lineStrong,
                    backgroundColor: t.color.paperSheet,
                  },
                ]}
              >
                <Animated.View
                  style={[
                    StyleSheet.absoluteFill,
                    styles.checkboxFill,
                    { backgroundColor: t.color.pine, opacity: tick },
                  ]}
                />
                <Animated.Text
                  allowFontScaling={false}
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                  style={[styles.checkmark, { color: t.color.onPine, opacity: tick }]}
                >
                  ✓
                </Animated.Text>
              </View>
              <Text
                style={[t.type.body, styles.agreeText, { color: t.color.inkBody }]}
              >
                {COPY.agree}
              </Text>
            </Pressable>
            <View
              style={[styles.consentDivider, { backgroundColor: t.color.lineSoft }]}
            />
            <View style={styles.consentInfo}>
              <InfoDisclosure
                label={COPY.noRecoveryLabel}
                lines={COPY.noRecoveryLines}
                testID="register-info-recovery"
              />
            </View>
          </View>

          {/* Until ticked the button sits recessed — paperInset, inkMuted,
              disabled to VoiceOver — via PrimaryButton's own disabled state.
              The ref lands on the button's Pressable: where VoiceOver
              returns after "Not yet". */}
          <PrimaryButton
            ref={createButtonRef}
            label={COPY.create}
            disabled={!agreed}
            reduceMotion={reduceMotion}
            onPress={presentSheet}
            testID="create-identity"
            style={styles.action}
          />

          {/* Teaching copy behind an affordance, the QrPanel idiom: the
              consequence above is not optional reading, this is. */}
          <View style={styles.explainRow}>
            <Pressable
              onPress={toggleExplain}
              accessibilityRole="button"
              accessibilityLabel={COPY.explainToggle}
              accessibilityState={{ expanded: explainOpen }}
              testID="register-explain"
              style={({ pressed }) => [
                styles.explainToggle,
                {
                  minHeight: t.layout.touchTarget,
                  borderRadius: t.radius.button,
                  backgroundColor: pressed ? t.color.pineWash : 'transparent',
                },
              ]}
            >
              <Text style={[t.type.buttonCompact, { color: t.color.pine }]}>
                {COPY.explainToggle}
              </Text>
              <Animated.View
                style={[styles.chevron, { transform: [{ rotate: chevronTurn }] }]}
              >
                <Text
                  allowFontScaling={false}
                  style={[styles.chevronGlyph, { color: t.color.pine }]}
                >
                  ›
                </Text>
              </Animated.View>
            </Pressable>
          </View>

          {explainMounted ? (
            <Animated.View style={{ opacity: reveal }}>
              <RuledLabel label={COPY.hiw[0].label} marginTop={24} />
              <KeyFlowDiagram />
              <Text style={[t.type.compactBody, styles.hiwBody, { color: t.color.inkMuted }]}>
                {COPY.hiw[0].body}
              </Text>
              <RuledLabel label={COPY.hiw[1].label} marginTop={24} />
              <ReachingYouDiagram />
              <Text style={[t.type.compactBody, styles.hiwBody, { color: t.color.inkMuted }]}>
                {COPY.hiw[1].body}
              </Text>
              <RuledLabel label={COPY.hiw[2].label} marginTop={24} />
              <IfLostDiagram />
              <Text style={[t.type.compactBody, styles.hiwBody, { color: t.color.inkMuted }]}>
                {COPY.hiw[2].body}
              </Text>
            </Animated.View>
          ) : null}

          {/* Policies end the page: centered reference links under a
              hairline, off the first screenful by design. */}
          <View
            style={[
              styles.policyFoot,
              { borderTopColor: t.color.lineSoft, borderTopWidth: t.hairline },
            ]}
          >
            <TextAction
              label={COPY.privacyLink}
              onPress={() => void openPolicy(PRIVACY_URL)}
              testID="register-privacy"
            />
            <Text style={[t.type.compactBody, styles.policySep, { color: t.color.inkMuted }]}>
              ·
            </Text>
            <TextAction
              label={COPY.termsLink}
              onPress={() => void openPolicy(TERMS_URL)}
              testID="register-terms"
            />
          </View>
        </View>
      </ScrollView>

      {sheet ? (
        <ConfirmSheet
          busy={busy}
          error={error}
          errorSeq={errorSeq}
          reduceMotion={reduceMotion}
          topInset={insets.top}
          bottomInset={insets.bottom}
          onConfirm={() => void create()}
          onDismiss={dismissSheet}
        />
      ) : null}
    </View>
  );
}

/** The fact/sheet glyph tile: 36pt of raised paper around a 22pt drawing. */
function Tile({ t, children }: { t: Theme; children: React.ReactNode }) {
  return (
    <View
      style={[
        styles.tile,
        {
          backgroundColor: t.color.paperSheet,
          borderColor: t.color.lineSoft,
          borderWidth: t.hairline,
        },
      ]}
    >
      {children}
    </View>
  );
}

/**
 * The confirm sheet: the app's first hovering surface, kept honest. An
 * in-tree absolutely-positioned View plus scrim — no RN Modal, no shadow.
 * Depth is scrim + paperLayer (house ladder ground → layer → sheet; the tiles
 * inside step up to paperSheet) + a top hairline, top radius 16, no grabber:
 * dismissal is a tap, not a drag. It slides up on motion.route; under Reduce
 * Motion it fades on motion.surface instead, and the scrim fades alongside in
 * both. VoiceOver focus moves to the title on present; the parent moves it
 * back to the Create button on dismiss.
 *
 * The register route mounts inside App's root SafeAreaView (edges top +
 * bottom), so the host backs that padding out with negative offsets — the
 * scrim and sheet must reach the physical display edges, and the designer
 * note's "14px bottom padding grows by the home-indicator inset" assumes a
 * sheet that touches the bottom. The host, not the sheet, carries
 * accessibilityViewIsModal: UIKit ignores only the SIBLINGS of the flagged
 * view, and the page behind is a sibling of the host. The sheet caps its
 * height under the status area and scrolls its rows, so at accessibility
 * text sizes the consequences stay readable while the buttons stay pinned.
 */
function ConfirmSheet({
  busy,
  error,
  errorSeq,
  reduceMotion,
  topInset,
  bottomInset,
  onConfirm,
  onDismiss,
}: {
  busy: boolean;
  error: string | null;
  errorSeq: number;
  reduceMotion: boolean;
  topInset: number;
  bottomInset: number;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const t = useTheme();
  const { height: winHeight } = useWindowDimensions();
  const titleRef = useRef<Text>(null);
  const present = useRef(new Animated.Value(0)).current;
  /** Frozen at the FIRST layout: a later relayout (the error row arriving)
   * must not move the slide's start offset mid-flight. */
  const [height, setHeight] = useState(0);
  /** The slide may only start from a truthful offset, which exists once the
   * sheet has measured; the Reduce Motion fade needs no measurement. */
  const ready = reduceMotion || height > 0;

  useEffect(() => {
    if (!ready) return;
    const arrive = Animated.timing(present, {
      toValue: 1,
      duration: reduceMotion ? t.motion.surface : t.motion.route,
      easing: t.motion.easing,
      useNativeDriver: true,
    });
    arrive.start();
    return () => arrive.stop();
    // Present once, with whatever motion setting held at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    // The button a finger just left is now under a scrim; on iOS nothing
    // announces that, so focus is moved by hand.
    const tag = findNodeHandle(titleRef.current);
    if (tag != null) AccessibilityInfo.setAccessibilityFocus(tag);
  }, []);

  // Ink at 32% — the one translucency the approved sheet spec adds.
  const scrim =
    t.scheme === 'dark' ? 'rgba(0,0,0,0.32)' : 'rgba(18,26,21,0.32)';

  const motionStyle = reduceMotion
    ? { opacity: present }
    : {
        transform: [
          {
            translateY: present.interpolate({
              inputRange: [0, 1],
              // Before the first layout answers, parked a full window
              // off-screen — a height no sheet exceeds, unlike a guess a
              // tall accessibility-text sheet could overshoot. The slide
              // itself waits for the measurement (`ready` above), so the
              // start offset never snaps mid-flight.
              outputRange: [height || winHeight, 0],
            }),
          },
        ],
      };

  return (
    <View
      testID="register-sheet-host"
      // On the host, not the sheet: VoiceOver ignores only the SIBLINGS of
      // the flagged view (the precedent screens flag their roots the same
      // way), and the page under the scrim is a sibling of this host.
      accessibilityViewIsModal
      style={[
        StyleSheet.absoluteFill,
        styles.sheetHost,
        // Back out the app-root SafeAreaView padding so the scrim and the
        // sheet reach the physical display edges.
        { top: -topInset, bottom: -bottomInset },
      ]}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: present }]}>
        <Pressable
          onPress={onDismiss}
          accessible={false}
          importantForAccessibility="no"
          testID="register-sheet-scrim"
          style={[StyleSheet.absoluteFill, { backgroundColor: scrim }]}
        />
      </Animated.View>

      <Animated.View
        testID="register-sheet"
        // The platform's modal-dismissal gesture (VoiceOver two-finger Z).
        // Routed through onDismiss, so mid-flight it refuses like every
        // other dismissal path.
        onAccessibilityEscape={onDismiss}
        onLayout={e => {
          const measured = e.nativeEvent.layout.height;
          setHeight(prev => (prev > 0 ? prev : measured));
        }}
        style={[
          styles.sheet,
          {
            backgroundColor: t.color.paperLayer,
            borderTopColor: t.color.lineSoft,
            borderTopWidth: t.hairline,
            paddingBottom: 14 + bottomInset,
            // Never under the status area: at accessibility text sizes the
            // content scrolls inside the cap instead of clipping the
            // consequence rows off the top of a bottom-anchored sheet.
            maxHeight: winHeight - topInset,
          },
          motionStyle,
        ]}
      >
        <ScrollView
          style={styles.sheetScroll}
          alwaysBounceVertical={false}
        >
          <Text style={[t.type.utilityLabel, { color: t.color.pine }]}>
            {COPY.sheetOverline}
          </Text>
          <Text
            ref={titleRef}
            accessibilityRole="header"
            style={[t.type.sectionTitle, styles.sheetTitle, { color: t.color.inkStrong }]}
          >
            {COPY.sheetTitle}
          </Text>

          {COPY.sheetRows.map((row, i) => (
            <View key={row.head} style={styles.sheetRow}>
              <Tile t={t}>
                {i === 0 ? <DashedPhoneGlyph /> : <SplitKeyGlyph />}
              </Tile>
              <View style={styles.factTxt}>
                <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
                  {row.head}
                </Text>
                <Text
                  style={[t.type.compactBody, styles.sheetRowBody, { color: t.color.inkMuted }]}
                >
                  {row.body}
                </Text>
              </View>
            </View>
          ))}
        </ScrollView>

        {error ? (
          <InlineError
            message={error}
            testID="register-error"
            seq={errorSeq}
            marginTop={20}
          />
        ) : null}

        <PrimaryButton
          label={COPY.create}
          busyLabel={COPY.creating}
          busy={busy}
          reduceMotion={reduceMotion}
          onPress={onConfirm}
          testID="register-sheet-confirm"
          style={styles.sheetAction}
        />

        <Pressable
          onPress={onDismiss}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={COPY.notYet}
          accessibilityState={{ disabled: busy }}
          testID="register-sheet-dismiss"
          style={({ pressed }) => [
            styles.notYet,
            {
              borderRadius: t.radius.button,
              backgroundColor: pressed ? t.color.pineWash : 'transparent',
            },
          ]}
        >
          <Text style={[t.type.buttonCompact, { color: t.color.pine }]}>
            {COPY.notYet}
          </Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flex: 1 },
  // Centred while the page is short, top-aligned once the copy (or an
  // accessibility text size) outgrows the screen and it starts scrolling.
  scrollContent: { flexGrow: 1, justifyContent: 'center', paddingVertical: 24 },
  page: { width: '100%', alignSelf: 'center' },
  eyebrow: { marginTop: 20 },
  title: { marginTop: 12 },
  paragraph: { marginTop: 12 },
  facts: { marginTop: 26, gap: 18 },
  fact: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  factTxt: { flex: 1, paddingTop: 1 },
  tile: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  consentCard: { padding: 16 },
  agreeRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    marginTop: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxFill: { borderRadius: 4.5 },
  checkmark: { fontSize: 14, fontWeight: '700', lineHeight: 17 },
  agreeText: { flex: 1 },
  consentDivider: { height: StyleSheet.hairlineWidth, marginTop: 14, marginBottom: 12 },
  /** 22 box + 12 gap: the ⓘ aligns under the sentence, not the box. */
  consentInfo: { marginLeft: 34 },
  action: { marginTop: 22 },
  // The pressed wash needs room without pulling the action off the page's
  // left edge.
  explainRow: { flexDirection: 'row', marginTop: 8, marginHorizontal: -8 },
  explainToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  chevron: { marginLeft: 6 },
  chevronGlyph: { fontSize: 15, lineHeight: 15, fontWeight: '600' },
  hiwBody: { marginTop: 10 },
  policyFoot: {
    marginTop: 44,
    paddingTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  policySep: { marginHorizontal: 2 },
  sheetHost: { justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 24,
    paddingHorizontal: 24,
  },
  /** Grows to its content while the sheet fits; shrinks into a scroll region
   * when the maxHeight cap bites, keeping error + buttons pinned below. */
  sheetScroll: { flexGrow: 0, flexShrink: 1 },
  sheetTitle: { marginTop: 10 },
  sheetRow: {
    flexDirection: 'row',
    gap: 14,
    alignItems: 'flex-start',
    marginTop: 20,
  },
  sheetRowBody: { marginTop: 5 },
  sheetAction: { marginTop: 24 },
  notYet: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
});
