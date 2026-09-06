import React, { useCallback, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as accounts from '../accounts';
import * as accountsPhone from '../accountsPhone';
import * as accountsUsername from '../accountsUsername';
import { ACCOUNTS_COPY } from '../accountsCopy';
import { ACCOUNTS_PHONE_COPY } from '../accountsPhoneCopy';
import { ACCOUNTS_USERNAME_COPY } from '../accountsUsernameCopy';
import * as db from '../db';
import { useKeyboardInset } from '../keyboardInset';
import { messaging } from '../messaging';
import { PHONE_UI_ENABLED } from '../phoneUi';
import { useTheme } from '../theme';
import { USERNAME_UI_ENABLED } from '../usernameUi';
import { InfoDisclosure } from '../ui/InfoDisclosure';
import {
  InlineNotice,
  PrimaryButton,
  ScreenHeader,
} from '../ui/primitives';

interface Props {
  onBack: () => void;
  onOpenChat: (chatId: string) => void;
}

/**
 * Find by email — the typed-SINGLE-identifier
 * flow, reached from the start-chat surface (QR stays the lead rail there).
 *
 * THE TWO RULES OF THIS GLASS:
 *
 *  1. NO ACCOUNT ID IS EVER RENDERED. The result card is labeled with the
 *     email the finder TYPED ("Start a chat with alice@example.com?"); the
 *     ULID the lookup resolved is an API fact that flows into the ordinary
 *     chat-open path and never reaches the tree — no testID carries it, no
 *     sentence includes it (the discovery-ux suite regexes the rendered
 *     tree for exactly this).
 *
 *  2. EVERY MISS LOOKS THE SAME, and the copy SAYS SO instead of guessing:
 *     not-on-Tacendum, registered-but-not-findable, a recovery cool-down,
 *     and this account's own spent search budget all answer one refusal by
 *     server design — rendering them
 *     differently would forge a distinction the wire deliberately withholds.
 *
 * Tapping the card opens the ordinary chat: first bundle fetch pins keys
 * TOFU, block-and-warn applies unchanged — discovery changes who you can
 * reach, never the trust model.
 *
 * THE TYPED CLASS, dark behind
 * `PHONE_UI_ENABLED`: under the pin the flow gains a class entry — type an
 * email OR a number, the class SHOWN, never silently inferred from the
 * text — and both rules above extend verbatim to the phone class (the
 * typed number lands on the card exactly as typed; every server refusal
 * of either class is the one outcome). With the pin false (every release
 * binary until the phone release train) nothing here changes: no selector renders and
 * the email flow is byte-identical to the landed one.
 *
 * THE THIRD CLASS, dark behind
 * `USERNAME_UI_ENABLED` on the same terms: a username chip joins the
 * selector, the typed handle rides to the card and becomes the localName
 * exactly as an email or number does (typed-text-becomes-localName,
 * no `@` sigil, never a name layer), and the chat it opens is marked
 * `discovery-username` so the provenance banner shows. A locally
 * malformed handle is refused here with its own sentence (this device's
 * knowledge); every server refusal is the one outcome.
 */
export function DiscoveryScreen({ onBack, onOpenChat }: Props) {
  const t = useTheme();
  const keyboardInset = useKeyboardInset();
  const [typed, setTyped] = useState('');
  const [classSel, setClassSel] = useState<db.IdentifierKind>(db.EMAIL_KIND);
  const [phase, setPhase] = useState<
    | { name: 'idle' }
    | { name: 'searching' }
    | { name: 'found'; typedEmail: string; anchor: string; deviceCount: number }
    | { name: 'none' }
    // The honest LOCAL refusal (phone class only): the number is not
    // E.164 — this device's own knowledge, never a server collapse.
    | { name: 'invalid' }
    | { name: 'error' }
  >({ name: 'idle' });
  const [ownEmailHint, setOwnEmailHint] = useState(false);
  const searchingNumber = PHONE_UI_ENABLED && classSel === db.PHONE_KIND;
  const searchingUsername = USERNAME_UI_ENABLED && classSel === db.USERNAME_KIND;
  // The selector renders when ANY typed class beyond email is live; each
  // chip is gated by its own pin.
  const classSelectorLive = PHONE_UI_ENABLED || USERNAME_UI_ENABLED;
  /** One live lookup at a time: every edit and
   * every new search bumps this sequence, and a response whose sequence is
   * no longer current is DROPPED — an older result can never render over a
   * newer query, and no second request starts while one is in flight (the
   * button disables on 'searching', and `search` refuses re-entry too). */
  const searchSeq = useRef(0);
  /** Whether a chip has been TAPPED on this visit. Until one is, the class
   * is the screen's default and the preselect below may move it. */
  const classChosen = useRef(false);

  const search = useCallback(() => {
    const query = typed.trim();
    if (query === '') return;
    // THE PRESELECT:
    // the door reads "Find by email or username" and this glass opens on the
    // Email chip, so a bare handle typed into it would run an email lookup
    // that can only miss. While NO chip has been tapped, the shape of what
    // was typed picks the class at search time — a USERNAME_STRICT-shaped
    // word (nothing with an @ ever is) is a username, anything else an email
    // — and the chip row flips to SHOW the choice before any result renders.
    // A tapped chip is a decision and always wins (the pinned "CHOSEN, never
    // inferred" cases): an email under the Username chip is that lookup's
    // local refusal, a handle under a tapped Email chip is an email lookup.
    // Pin false: nothing here moves and the landed flow is byte-identical.
    let kind = classSel;
    if (USERNAME_UI_ENABLED && !classChosen.current && kind !== db.PHONE_KIND) {
      kind =
        accountsUsername.normalizedUsernameOrNull(query) !== null
          ? db.USERNAME_KIND
          : db.EMAIL_KIND;
      if (kind !== classSel) setClassSel(kind);
    }
    const byUsername = USERNAME_UI_ENABLED && kind === db.USERNAME_KIND;
    const byNumber = PHONE_UI_ENABLED && kind === db.PHONE_KIND;
    setPhase({ name: 'searching' });
    // Claiming the sequence supersedes any in-flight lookup: its response
    // will compare stale below and drop — the NEWER request always wins.
    const mySeq = ++searchSeq.current;
    void (async () => {
      // The honest local hint (the caller gate is server-enforced and its
      // refusal is uniform BY DESIGN; this device still knows its OWN
      // state and may say so): searching needs a verified identifier here
      // too — the gate is CLASS-BLIND, so under the phone
      // pin EITHER class's verified row quiets the hint.
      const own = await db.loadAccountIdentifier().catch(() => null);
      const ownNumber = PHONE_UI_ENABLED
        ? await db.loadPhoneIdentifier().catch(() => null)
        : null;
      const result = byUsername
        ? await accountsUsername.discoverySearchByUsername(query)
        : byNumber
          ? await accountsPhone.discoverySearchByPhone(query)
          : await accounts.discoverySearch(query);
      if (searchSeq.current !== mySeq) return; // superseded — drop, silently
      setOwnEmailHint(own?.email == null && ownNumber?.phone == null);
      if (result.outcome === 'found') {
        setPhase({
          name: 'found',
          // The TYPED text, exactly as typed (trimmed only) — the label is
          // the finder's own knowledge, never a normalized rewrite of it; the wire lookup normalizes on its own. One rule,
          // both classes.
          typedEmail: query,
          anchor: result.anchor,
          deviceCount: result.deviceCount,
        });
      } else if (result.outcome === 'no_match') {
        setPhase({ name: 'none' });
      } else if (result.outcome === 'invalid') {
        setPhase({ name: 'invalid' });
      } else {
        setPhase({ name: 'error' });
      }
    })();
  }, [typed, classSel]);

  const startChat = useCallback(() => {
    if (phase.name !== 'found') return;
    const { typedEmail, anchor } = phase;
    void (async () => {
      // The provenance mark: a username-found chat is
      // 'discovery-username', so the banner shows and a client-local
      // "found as X" line can one day read the class; the shipped classes
      // keep their 'discovery' bytes.
      await accounts.startDiscoveredChat(
        typedEmail,
        anchor,
        undefined,
        searchingUsername ? db.DISCOVERY_USERNAME_INTRODUCED : 'discovery',
      );
      // The label rides to siblings like any nickname —
      // best-effort, exactly the StartChat naming path.
      void messaging.syncLocalName(anchor, typedEmail).catch(() => undefined);
      onOpenChat(anchor);
    })().catch(() => setPhase({ name: 'error' }));
  }, [phase, onOpenChat, searchingUsername]);

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: t.color.paperGround, paddingBottom: keyboardInset },
      ]}
    >
      {/* The header names the SELECTED class: the
          email title must not sit over a phone flow. Pin false: the landed
          email title, byte-for-byte. */}
      <ScreenHeader
        title={
          searchingUsername
            ? ACCOUNTS_USERNAME_COPY.findTitle
            : searchingNumber
              ? ACCOUNTS_PHONE_COPY.discoverTitleNumber
              : ACCOUNTS_COPY.discoverTitle
        }
        onBack={onBack}
        testIDBack="discovery-back"
      />
      <ScrollView
        contentContainerStyle={[styles.body, { paddingHorizontal: t.layout.gutter }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[t.type.compactBody, { color: t.color.inkBody }]}>
          {searchingUsername
            ? ACCOUNTS_USERNAME_COPY.findNote
            : searchingNumber
              ? ACCOUNTS_PHONE_COPY.discoverIntroNumber
              : ACCOUNTS_COPY.discoverIntro}
        </Text>

        {/* THE TYPED CLASS (under the build pin; the username
            chip under its own pin): the class is a visible choice —
            email, number, or username — never SILENTLY inferred from what
            was typed: until a chip is tapped, a username-shaped word moves
            the lit chip at search time (the preselect in `search`), and a
            tapped chip is final. Switching classes resets the flow exactly
            like an edit: any in-flight lookup is superseded. */}
        {classSelectorLive ? (
          <View style={styles.classRow}>
            {(
              [
                [db.EMAIL_KIND, ACCOUNTS_PHONE_COPY.classLabelEmail, 'discovery-class-email', true],
                [db.PHONE_KIND, ACCOUNTS_PHONE_COPY.classLabelNumber, 'discovery-class-number', PHONE_UI_ENABLED],
                [db.USERNAME_KIND, ACCOUNTS_USERNAME_COPY.findClass, 'discovery-class-username', USERNAME_UI_ENABLED],
              ] as const
            ).filter(([, , , live]) => live).map(([kind, label, testID]) => {
              const selected = classSel === kind;
              return (
                <Pressable
                  key={kind}
                  onPress={() => {
                    // A tap is a decision, even on the chip already lit:
                    // from here the preselect never moves the class.
                    classChosen.current = true;
                    if (classSel === kind) return;
                    setClassSel(kind);
                    searchSeq.current += 1;
                    setPhase({ name: 'idle' });
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={label}
                  testID={testID}
                  style={[
                    styles.classChip,
                    {
                      borderRadius: t.radius.button,
                      borderWidth: 1,
                      borderColor: selected ? t.color.pine : t.color.lineStrong,
                      backgroundColor: selected ? t.color.pineWash : t.color.paperSheet,
                    },
                  ]}
                >
                  <Text
                    style={[
                      t.type.buttonCompact,
                      { color: selected ? t.color.pine : t.color.inkMuted },
                    ]}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <TextInput
          value={typed}
          onChangeText={next => {
            setTyped(next);
            // Editing invalidates any in-flight lookup too: a
            // late response must not render a result for text no longer in
            // the field.
            searchSeq.current += 1;
            setPhase(current => (current.name === 'idle' ? current : { name: 'idle' }));
          }}
          onSubmitEditing={search}
          placeholder={
            searchingUsername
              ? ACCOUNTS_USERNAME_COPY.findPlaceholder
              : searchingNumber
                ? ACCOUNTS_PHONE_COPY.numberPlaceholder
                : ACCOUNTS_COPY.emailPlaceholder
          }
          placeholderTextColor={t.color.inkMuted}
          keyboardAppearance={t.scheme}
          selectionColor={t.color.pine}
          accessibilityLabel={
            searchingUsername
              ? ACCOUNTS_USERNAME_COPY.findTitle
              : searchingNumber
                ? ACCOUNTS_PHONE_COPY.discoverTitleNumber
                : ACCOUNTS_COPY.discoverTitle
          }
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          keyboardType={
            searchingUsername ? 'default' : searchingNumber ? 'phone-pad' : 'email-address'
          }
          returnKeyType="search"
          testID="discovery-input"
          style={[
            t.type.input,
            styles.input,
            {
              minHeight: t.layout.buttonHeight,
              borderRadius: t.radius.button,
              backgroundColor: t.color.paperSheet,
              color: t.color.inkStrong,
              borderWidth: 1,
              borderColor: t.color.lineStrong,
            },
          ]}
        />
        <PrimaryButton
          label={ACCOUNTS_COPY.discoverSearch}
          onPress={search}
          disabled={typed.trim() === '' || phase.name === 'searching'}
          busy={phase.name === 'searching'}
          testID="discovery-search"
        />

        {phase.name === 'none' ? (
          <>
            <InlineNotice
              tone="quiet"
              message={
                searchingUsername
                  ? ACCOUNTS_USERNAME_COPY.findNoMatch
                  : searchingNumber
                    ? ACCOUNTS_PHONE_COPY.discoverNoMatchNumber
                    : ACCOUNTS_COPY.discoverNoMatch
              }
              testID="discovery-no-match"
            />
            {ownEmailHint ? (
              <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
                {PHONE_UI_ENABLED
                  ? ACCOUNTS_PHONE_COPY.discoverNeedsOwnIdentifier
                  : ACCOUNTS_COPY.discoverNeedsOwnEmail}
              </Text>
            ) : null}
          </>
        ) : null}

        {phase.name === 'invalid' ? (
          <InlineNotice
            tone="quiet"
            message={
              searchingUsername
                ? ACCOUNTS_USERNAME_COPY.invalid
                : ACCOUNTS_PHONE_COPY.numberInvalid
            }
            testID="discovery-invalid"
          />
        ) : null}

        {phase.name === 'error' ? (
          <InlineNotice
            tone="quiet"
            message={ACCOUNTS_COPY.discoverError}
            testID="discovery-error"
          />
        ) : null}

        {phase.name === 'found' ? (
          <Pressable
            onPress={startChat}
            accessibilityRole="button"
            accessibilityLabel={ACCOUNTS_COPY.discoverResult(phase.typedEmail)}
            testID="discovery-result"
            style={({ pressed }) => [
              styles.card,
              {
                borderRadius: t.radius.button,
                backgroundColor: pressed ? t.color.pineWash : t.color.paperSheet,
                borderWidth: 1,
                borderColor: t.color.lineStrong,
              },
            ]}
          >
            <Text style={[t.type.body, { color: t.color.inkStrong }]}>
              {ACCOUNTS_COPY.discoverResult(phase.typedEmail)}
            </Text>
            <Text style={[t.type.compactBody, styles.cardLine, { color: t.color.inkMuted }]}>
              {ACCOUNTS_COPY.discoverResultDevices(phase.deviceCount)}
            </Text>
            <Text style={[t.type.compactBody, styles.cardLine, { color: t.color.inkMuted }]}>
              {/* The class that produced this card: switching
                  classes resets the phase, so the selection and the result
                  can never disagree here. */}
              {searchingUsername
                ? ACCOUNTS_USERNAME_COPY.findTofu
                : searchingNumber
                  ? ACCOUNTS_PHONE_COPY.discoverTofuNumber
                  : ACCOUNTS_COPY.discoverTofu}
            </Text>
            <Text
              style={[t.type.buttonCompact, styles.cardAction, { color: t.color.pine }]}
            >
              {ACCOUNTS_COPY.discoverStart}
            </Text>
          </Pressable>
        ) : null}

        {/* The explainer speaks the SELECTED class: the email
            lines discussed typing and verifying an email even while the
            number class was live. The label is class-neutral and shared. */}
        <InfoDisclosure
          label={ACCOUNTS_COPY.discoverExplainLabel}
          lines={
            searchingUsername
              ? ACCOUNTS_USERNAME_COPY.findExplain
              : searchingNumber
                ? ACCOUNTS_PHONE_COPY.discoverExplainNumber
                : PHONE_UI_ENABLED
                  ? ACCOUNTS_PHONE_COPY.discoverExplainEmailBoth
                  : ACCOUNTS_COPY.discoverExplain
          }
          testID="discovery-info"
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { paddingTop: 8, paddingBottom: 48, gap: 14 },
  input: { paddingHorizontal: 14 },
  card: { padding: 14 },
  cardLine: { marginTop: 6 },
  cardAction: { marginTop: 10 },
  classRow: { flexDirection: 'row', gap: 10 },
  classChip: { paddingHorizontal: 14, paddingVertical: 8 },
});
