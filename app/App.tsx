import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  Animated,
  AppState,
  BackHandler,
  Keyboard,
  PanResponder,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useColorScheme,
  useWindowDimensions,
} from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import './src/devhook';
import { getSecret, hasIdentity } from 'tacendum-crypto';
// The membership fold: one answer about who is in a room, shared by the room
// thread, the send path and the in-call Add picker.
import { foldRoster } from '@tacendum/shared/group-fold';
import {
  type CallState,
  type ClientPolicyResponse,
  smallGroupCallParticipantCap,
} from '@tacendum/shared';
import { clearBadge, syncBadge } from './src/badge';
import {
  activateCallMetricDrainForWorkspace,
  nudgePushRegistration,
  quiesceCallMetrics,
  resumeCallMetricDrainAfterTransportResume,
} from './src/call';
import { refreshDecoyTimestamps } from './src/decoy';
import * as db from './src/db';
import { DEVICE_NOUN } from './src/deviceNoun';
import { isFirstRunAfterInstall, markInstalled } from './src/install';
import * as lock from './src/lock';
import { AUTH_TOKEN_KEY, messaging } from './src/messaging';
import {
  clearGoneAccount,
  clearStaleInstallationCredentials,
  createOrRestoreAccount,
  deleteAccount,
  hasPendingAccountDeletion,
} from './src/registration';
import { PrimaryButton, TextAction } from './src/ui/primitives';
import { BrandMark } from './src/ui/BrandMark';
import { CallPicker } from './src/ui/CallPicker';
import { EmptyDetail } from './src/ui/EmptyDetail';
import { TabBar } from './src/ui/TabBar';
import { CallScreen } from './src/screens/CallScreen';
import { CallOverlay } from './src/screens/CallOverlay';
import { GroupCallScreen } from './src/screens/GroupCallScreen';
import { CallsScreen } from './src/screens/CallsScreen';
import { IncomingCallScreen } from './src/screens/IncomingCallScreen';
import { ChatListScreen } from './src/screens/ChatListScreen';
import { AttentionScreen } from './src/screens/AttentionScreen';
import { GroupCreateScreen } from './src/screens/GroupCreateScreen';
import { ChatThreadScreen } from './src/screens/ChatThreadScreen';
import { AccountEmailScreen } from './src/screens/AccountEmailScreen';
import { AccountPhoneScreen } from './src/screens/AccountPhoneScreen';
import { AccountUsernameScreen } from './src/screens/AccountUsernameScreen';
import { DiscoveryScreen } from './src/screens/DiscoveryScreen';
import { LandingScreen } from './src/screens/LandingScreen';
import { LinkConfirmScreen } from './src/screens/LinkConfirmScreen';
import { LinkDeviceScreen } from './src/screens/LinkDeviceScreen';
import { LinkedDevicesScreen } from './src/screens/LinkedDevicesScreen';
import { RecoveryScreen } from './src/screens/RecoveryScreen';
import { LockScreen } from './src/screens/LockScreen';
import { NamingScreen } from './src/screens/NamingScreen';
import { GroupProfileScreen } from './src/screens/GroupProfileScreen';
import { PeerProfileScreen } from './src/screens/PeerProfileScreen';
import { PhotoViewerScreen } from './src/screens/PhotoViewerScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { RegisterScreen } from './src/screens/RegisterScreen';
import { UpdateRequiredScreen } from './src/screens/UpdateRequiredScreen';
import { SettingsScreen, type SettingsSection } from './src/screens/SettingsScreen';
import { StartChatScreen } from './src/screens/StartChatScreen';
import {
  appearanceChoice,
  subscribeAppearance,
} from './src/appearance';
import {
  acceptIncomingCall,
  adoptPushRegistration,
  adoptWorkspaceForCalling,
  callController,
  // The refusal type, from the BARREL: `placeCall` throws it, and telling
  // "you blocked them" from "their safety number changed" is what lets a
  // Call button say why it did nothing. Reaching into
  // `call/controller` for it would make this the first production module
  // outside `src/call/` to do so.
  CallRefusedError,
  disposeGroupCall,
  endCallOnQuiesce,
  ensurePermissions,
  flipCamera,
  groupCall,
  loadAlwaysRelay,
  loadSilenceUnknownCallers,
  localMediaState,
  refreshSelfAccountId,
  resetAlwaysRelayForDuress,
  resetSilenceUnknownCallersForDuress,
  restoreVideoQuality,
  setSelfAccountId,
  startCalling,
  startGroupCall,
  switchToVoice,
  toggleGroupMute,
  toggleGroupSpeaker,
  toggleMute,
  toggleSpeaker,
  toggleVideo,
  useCallState,
  useGroupCallState,
} from './src/call';
// The sentences a refused call shows. Pure, and the class-to-sentence map is
// total over `CallRefusedError`'s own reason union.
import { CALL_REFUSAL_FOR } from './src/callRefusalCopy';
// A cid is a ULID, and msgid.ts already owns the app's generator — including
// its pre-fetched entropy pool. A second one here would be a second place for
// randomness to be got wrong.
import { onPendingOffer, onRecoveryNotice, pendingOfferWaiting } from './src/linking';
import { recoveryIntent, recoveryRowVisible, setRecoveryIntent } from './src/accounts';
import { nextMsgId } from './src/msgid';
import { personName } from './src/person';
import type { PipCorner } from './src/ui/pipDrag';
import { retractSelfId } from './src/nse';
import { consumePendingNav } from './src/pushnav';
import {
  armPreviews,
  disarmPreviews,
  loadPreviewLevel,
  renewPreviews,
  resetPreviewLevelForDuress,
} from './src/previews';
import { loadReadReceipts, resetReadReceiptsForDuress } from './src/readReceipts';
import {
  loadTypingIndicators,
  resetTypingIndicatorsForDuress,
} from './src/typingIndicators';
import { resetFieldModeForDuress } from './src/fieldMode';
import { loadPushConsent, resetPushConsentForDuress } from './src/pushConsent';
import { accountGone, onAccountGone } from './src/reauth';
import { clearWritingConnections, invalidateWritingSession, setWritingAccess, setWritingForeground } from './src/aiWritingService';
import { screenSecurity } from './src/screenSecurity';
import { session } from './src/session';
import { type CheckReason, storeUrl, updateGate } from './src/updateGate';
import { ThemeProvider, useTheme } from './src/theme';
import { useReduceMotion } from './src/useReduceMotion';
import {
  compactVisibleSurface,
  deriveSurfaceFacts,
  wideVisibleSurface,
} from './src/visibleSurface';
import {
  PaneWidthProvider,
  WindowClassProvider,
  useWindowClass,
} from './src/windowClass';

/** Capture-cover copy. 'shared or recorded' — isCaptured is also AirPlay,
 * mirroring and casting, and this deck does not say things that are false. */
const COPY_COVER = {
  line: 'The screen is being shared or recorded.\nMessages wait until it stops.',
  over: 'The screen is no longer shared. Messages are visible.',
};

/**
 * Account-gone copy. The old identity cannot be restored.
 * An explicit, confirmed local erase now allows setup with a fresh identity;
 * it never promises to restore the deleted account or its conversations.
 */
const COPY_GONE = {
  title: 'This device can no longer sign in',
  // The device is named in the
  // platform's own words via the token.
  line:
    `The identity on this ${DEVICE_NOUN} cannot sign in to its saved account. ` +
    'It may have been deleted, revoked, or belong to different credentials. ' +
    'What is already on this device stays on it until you choose to erase it.',
};

/**
 * The mark, centred — what every cover shows. The mark says the name in
 * shape; no wordmark text accompanies it. (The lock screen holds its mark at
 * the quarter line instead: the pad owns the lower half there.)
 */
function CoverBrand() {
  return <BrandMark size={20} />;
}

/**
 * The router's route union. Exported for `App.routes.test.tsx` alone — the
 * TOTALITY test builds one concrete route per name, and a hand-kept copy of
 * the union inside the test would be exactly the drift that test exists to
 * catch. Nothing outside this file routes.
 */
export type Route =
  | { name: 'loading' }
  | { name: 'locked' }
  | { name: 'landing' }
  // The update wall: the server's answer to "what
  // build do you still talk to" came back above this binary's. A ROUTE and
  // not a modal, because nothing behind it ran — the workspace opening
  // returns before `messaging.start`, so there is no workspace to dismiss
  // back into. Joined THROUGH the visible-surface module .
  | { name: 'updateRequired' }
  | { name: 'register' }
  | { name: 'chats' }
  | { name: 'calls' }
  | { name: 'attention' }
  | { name: 'newChat' }
  | { name: 'newRoom' }
  | {
      name: 'thread';
      peerId: string;
      from?: 'chats' | 'calls' | 'attention';
      focusedApprovalQ?: string;
    }
  // ORIGINS. These three are pushed from more than one place, and
  // until this field existed the table below guessed — so a profile opened
  // on the Calls tab dropped a person on Chats, and the App Lock nudge sent
  // someone from the chat list into a Profile screen they never asked for.
  // A FIELD on an existing name, never a new name: `visibleSurface.ts`
  // classifies by route name and its 23-cell matrix must not move.
  | { name: 'profile'; from?: 'chats' | 'calls' }
  | { name: 'settings'; from?: 'chats' | 'profile'; section?: SettingsSection }
  // Device linking: the roster, the scan side, and the
  // new-device confirm surface. Joined THROUGH the visible-surface module
  //  — ordinary workspace surfaces to all four consumers.
  // THE SETTINGS ORIGIN RIDES THROUGH. Every surface below is
  // entered from Settings, and each carries the origin SETTINGS itself was
  // entered with. Without it the first Back was right and the second was
  // wrong — chat list, App Lock nudge, Settings, Linked devices, Back, Back
  // and a person is on a Profile screen they never asked for, which is the
  // sentence the `settings` case exists to prevent, one level down.
  | { name: 'linkedDevices'; from?: 'chats' | 'profile' }
  | { name: 'linkDevice'; from?: 'chats' | 'profile' }
  | { name: 'linkConfirm'; from?: 'chats' | 'calls' }
  // Identifier, discovery and recovery: the email surface (opened from
  // Settings), the find-by-email surface (entered from
  // Start a chat), and the recovery surface (entered from Landing — BESIDE
  // registration, never in it; `from` remembers which door, so back agrees
  // with it).
  | { name: 'accountEmail'; from?: 'chats' | 'profile'; via?: 'username' }
  // The phone surface renders nothing while PHONE_UI_ENABLED is false.
  // It has no Settings row and is reachable programmatically only.
  | { name: 'accountPhone'; from?: 'chats' | 'profile' }
  // The username surface : the identifier
  // siblings' sibling, dark behind the build-pinned USERNAME_UI_ENABLED —
  // the screen renders nothing while the pin is false, and its Settings row
  // renders only under the same pin, so a dark binary has neither the door
  // nor the room.
  | { name: 'accountUsername'; from?: 'chats' | 'profile' }
  | { name: 'discover' }
  | { name: 'recover'; from?: 'landing' | 'chats' }
  | {
      name: 'peerProfile';
      peerId: string;
      from?: 'chats' | 'calls' | 'attention';
      // Where the profile was opened from when not its own thread: a room
      // member's profile pops back to the ROOM profile, never into a 1:1
      // with someone you only share a room with.
      via?: { name: 'groupProfile'; groupId: string };
    }
  | {
      name: 'groupProfile';
      groupId: string;
      from?: 'chats' | 'calls' | 'attention';
    }
  | {
      name: 'photoViewer';
      peerId: string;
      msgId: string;
      direction: 'in' | 'out';
      // The THREAD's origin, riding through the photo: both of photoViewer's
      // exits (its close control and hardware back) rebuild the thread, and
      // a rebuild without `from` forgets that a Calls-origin thread pops to
      // Calls — the second back would land on Chats.
      from?: 'chats' | 'calls' | 'attention';
    };

/**
 * The routes the wide shell projects as list-beside-detail. Wide is a PROJECTION of this one Route union, never a second
 * router: the same state renders one pane on a phone and two on a wide
 * window. Absent from this set, deliberately:
 *
 *   - loading / locked / landing / register — the pre-workspace surfaces.
 *     No workspace means no list to show beside them; they stay full-window
 *     at every width, so the lock screen on an iPad is exactly the lock
 *     screen on a phone.
 *   - photoViewer — full-bleed black with a light status bar; a lit paper
 *     list beside it would defeat the viewer's own ground, and its
 *     crossfade transition (no horizontal movement) assumes the whole
 *     window. It stays full-window, as its edges=[] SafeAreaView already
 *     requires.
 *   - calls were never routes at all: both call surfaces stay full-window
 *     ROUTER SIBLINGS on every width, mounted below the capture cover.
 */
const PANE_PROJECTED: ReadonlySet<Route['name']> = new Set<Route['name']>([
  'chats',
  'calls',
  'attention',
  'newChat',
  'newRoom',
  'thread',
  'profile',
  'settings',
  'peerProfile',
  'groupProfile',
]);

/**
 * Which shape a MINIMIZED 1:1 call gets over each route ("go back to
 * the chat while the video call is on"): the small
 * `window`, or the `full` screen regardless of the person's choice. EVERY
 * route decides — a `Record` over the union, the DEPTH idiom below, so a new
 * route refuses to compile until its row is written; a denylist here would
 * let a future pre-workspace surface (a sign-in step, an onboarding page)
 * arrive with the window silently allowed over it. `full` is exactly the set
 * `visibleSurface.ts` calls NO_WORKSPACE — restated rather than imported
 * because this is a render condition, not a security fact — and App.callminimize.test.tsx pins the two
 * equal in both directions through `provesWorkspaceOpen`. The full
 * `CallScreen` is the surface proven over the lock route
 * (visible-surface.test.ts); a call that is on glass over any `full`
 * route gets that surface, never the small window. In a duress session the
 * same refusal applies (`callOverlayAllowed`): a duress workspace never
 * carries a real session's call (relock ends the call before
 * any verdict), so the gate is belt-and-braces there, and pinned as such.
 */
export const CALL_OVERLAY_SURFACE: Record<Route['name'], 'full' | 'window'> = {
  // Pre-workspace: nothing to minimize TO.
  loading: 'full',
  locked: 'full',
  landing: 'full',
  register: 'full',
  recover: 'full',
  updateRequired: 'full',
  // The workspace.
  chats: 'window',
  calls: 'window',
  attention: 'window',
  newChat: 'window',
  newRoom: 'window',
  thread: 'window',
  profile: 'window',
  settings: 'window',
  peerProfile: 'window',
  groupProfile: 'window',
  photoViewer: 'window',
  linkedDevices: 'window',
  linkDevice: 'window',
  linkConfirm: 'window',
  accountEmail: 'window',
  accountPhone: 'window',
  accountUsername: 'window',
  discover: 'window',
};

/** Whether the minimized call window may be on glass over this route now. */
function callOverlayAllowed(routeName: Route['name']): boolean {
  return session.mode !== 'duress' && CALL_OVERLAY_SURFACE[routeName] === 'window';
}

/**
 * Is a call surface holding the WHOLE screen right now?
 *
 * This is the render conditions below, restated as one predicate, because
 * Android's Back has to answer the same question they do: if the person
 * cannot see the router, a press that moves the router is a navigation they
 * cannot see either — the exact defect the 1:1 minimize was written to stop,
 * which it stopped for two states out of eight and for the 1:1 machine only.
 *
 * Pure and exported so `back.android.test.ts` can walk every state name
 * rather than fight the real machine into each one. It says nothing about
 * whether Back SHOULD be consumed — `goBack` decides that, and only after
 * offering the minimize.
 */
export function callSurfaceOwnsGlass(now: {
  call: CallState;
  callMinimized: boolean;
  overlayAllowed: boolean;
  groupCallLive: boolean;
}): boolean {
  // A small-group session has exactly one shape — the full screen. It has no
  // window to go to, so while it is live it owns the glass. (Whether it
  // should GAIN a minimize is a separate and larger question.)
  if (now.groupCallLive) return true;
  if (now.call.name === 'idle' || now.call.call === null) return false;
  // The 1:1 call is in the small draggable window exactly when the render
  // slot below puts it there; in every other live state the surface on glass
  // is the full `CallScreen`, or the full `IncomingCallScreen` for the ring.
  const windowed =
    now.callMinimized &&
    now.overlayAllowed &&
    (now.call.name === 'connected' ||
      now.call.name === 'reconnecting' ||
      now.call.name === 'ending');
  return !windowed;
}

function App() {
  const [choice, setChoice] = useState(appearanceChoice);
  useEffect(() => subscribeAppearance(setChoice), []);
  // useColorScheme is only consulted when the person chose "system", but the
  // hook must run unconditionally.
  const system = useColorScheme();
  const mode =
    choice === 'system' ? (system === 'dark' ? 'dark' : 'light') : choice;
  return (
    <SafeAreaProvider>
      <ThemeProvider mode={mode}>
        {/* Paper ground wants dark ink in the bar; the night ground, light. */}
        <StatusBar
          barStyle={mode === 'dark' ? 'light-content' : 'dark-content'}
        />
        {/* The window-class shell:
            mounted ONCE, at the shell root, never per screen. It
            owns "how wide is this window, and what class is that" for
            everything below; the panes claim their own widths inside
            (PaneWidthProvider), and a providerless subtree still answers
            compact by design. */}
        <WindowClassProvider>
          <AppContent />
        </WindowClassProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function AppContent() {
  const t = useTheme();
  // THE SHELL AXIS: which projection this window
  // renders. Width-driven, never idiom-driven (windowClass.ts) — only
  // `expanded` (≥840dp) projects two panes; `medium` keeps the compact
  // layout. The window width
  // itself is read for the pane split below.
  const windowClass = useWindowClass();
  const { width: windowWidth } = useWindowDimensions();
  // What the panes may actually divide: the root
  // SafeAreaView reserves left/right insets, so on a
  // landscape notched device the panes row is NARROWER than the window by
  // exactly that reservation. The pane split must divide the true rendered
  // width, or every pane is promised more than it has. Zero on portrait
  // phones and inset-less tablets, where this is windowWidth unchanged.
  const rootInsets = useSafeAreaInsets();
  const paneAreaWidth = Math.max(
    0,
    windowWidth - rootInsets.left - rootInsets.right,
  );
  const [route, setRoute] = useState<Route>({ name: 'loading' });
  // Calls live beside the router rather than inside it, so state survives
  // navigation.
  const call = useCallState();
  // Mirrored into a ref for the AppState listener, whose closure is created
  // once (its effect deps are [relock]) and would otherwise hold the call
  // state from mount forever — pausing the socket mid-call because it still
  // saw 'idle'.
  const callRef = useRef(call);
  callRef.current = call;
  /**
   * THE MINIMIZED CALL. Whether the person put
   * the live 1:1 call away to use the app: true swaps the full `CallScreen`
   * for the small draggable `CallOverlay` in the SAME render slot, so the
   * z-order against the covers and the visible-surface model's overlay fact
   * (`call.name !== 'idle'`) are untouched — a minimized call is still a
   * call on glass, still covered during capture, still ended by relock.
   *
   * PER CALL, reset at RENDER time when the call's cid changes — the
   * `previousGroupUiSessionKey` idiom below: effects run after the commit,
   * so a reset-in-effect would paint the NEXT call's first frame minimized.
   * Ending resets it (cid → null); a new call starts full screen.
   */
  const [callMinimized, setCallMinimized] = useState(false);
  const callMinimizedRef = useRef(callMinimized);
  callMinimizedRef.current = callMinimized;
  const liveCallCid = call.call?.cid ?? null;
  // The two video layout choices belong to this call, not to a particular
  // mount of its full-screen surface. Keep them through minimize/restore,
  // then synchronously reset before a different cid's first render.
  const callVideoPresentation = useRef<{
    cid: string | null;
    swapped: boolean;
    pipCorner: PipCorner;
  }>({ cid: liveCallCid, swapped: false, pipCorner: 'top-right' });
  if (callVideoPresentation.current.cid !== liveCallCid) {
    callVideoPresentation.current = {
      cid: liveCallCid,
      swapped: false,
      pipCorner: 'top-right',
    };
  }
  const [previousMinimizedCid, setPreviousMinimizedCid] = useState(liveCallCid);
  if (previousMinimizedCid !== liveCallCid) {
    setPreviousMinimizedCid(liveCallCid);
    if (callMinimized) setCallMinimized(false);
  }
  // The pause that BACKGROUNDING skipped, taken when the CALL ends instead.
  // Backgrounding during a call deliberately leaves the socket open (it is
  // the call's signalling path, and the voip background mode keeps the
  // process alive) — but when the call then ends while still backgrounded,
  // nothing revisited that decision. iOS suspends the process seconds later
  // with a live connection row behind it, and the server delivers the NEXT
  // offer or cancel into the frozen buffer and pushes nothing: the phone
  // cannot ring again for up to the idle timeout. Same guard set as the
  // backgrounding pause, same reasoning — which is NO route or mode guard on
  // the pause itself (see the effect below for the history of the one it used
  // to carry; only the badge sync there still keeps it).
  // The in-call surfaces used to render `personName(peerId)` BARE — no name
  // arguments at all — which is the ULID fallback by construction. Found
  // live: every call showed a shortened id on both phones while the
  // chat list, reading the same table, showed real names. Resolved async
  // because the lookup is the database; until it lands (or when the db is
  // locked) the fallback is what it always was.
  // KEYED to the peer it was resolved for, checked at RENDER time: effects
  // run after the commit, so any reset-in-effect scheme still paints one
  // frame of the previous caller's name on a back-to-back call from someone
  // else. A name that does not match the current peer simply does not
  // render; the id fallback for a few frames is honest, a wrong name never
  // is.
  const [resolvedPeer, setResolvedPeer] = useState<{
    peerId: string;
    name: string;
    avatarB64: string | null;
  } | null>(null);
  const callPeerId = call.call?.peerId;
  useEffect(() => {
    if (!callPeerId) {
      setResolvedPeer(null);
      return;
    }
    let gone = false;
    void db
      .getChat(callPeerId)
      .then(c => {
        if (!gone) {
          setResolvedPeer({
            peerId: callPeerId,
            name: personName(callPeerId, c?.displayName, c?.localName),
            avatarB64: c?.avatarB64 ?? null,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [callPeerId]);
  const callPeerName =
    resolvedPeer && resolvedPeer.peerId === callPeerId ? resolvedPeer.name : null;
  const callPeerAvatar =
    resolvedPeer && resolvedPeer.peerId === callPeerId ? resolvedPeer.avatarB64 : null;

  const prevCallName = useRef(call.name);
  useEffect(() => {
    const was = prevCallName.current;
    prevCallName.current = call.name;
    if (was === 'idle' || call.name !== 'idle') return;
    const state = AppState.currentState;
    if (state !== 'background' && state !== 'inactive') return;
    // pause() is UNCONDITIONAL, matching the backgrounding pause this effect
    // completes. It shipped guarded by `session.mode === 'real' && route !==
    // 'locked'` ("same guards as the original") — but that pair is
    // the RESUME guard, where it is load-bearing because resume() DIALS: a
    // socket must not run behind the lock, and duress is
    // network-silent. pause() points the other way — it only ever
    // CLOSES, and self-guards on `this.token` for never-started and stopped
    // sessions. Duress cannot make it speak: messaging is never STARTED in a
    // duress session (`enterDecoyWorkspace`), and the relock that
    // precedes every verdict runs `messaging.stop()` itself, so by the time a
    // duress session exists the token this method guards on is gone and the
    // call is already ended (`endCallOnQuiesce` runs before the stop). The
    // one close frame pause() can emit behind the lock is the REAL session's
    // own socket closing — the exact bytes relock's stop() sends anyway. The
    // skip left one reachable locked window — a real verdict's opening still
    // in flight (messaging started, route not yet 'chats') when a
    // backgrounded call ends — holding the socket open for iOS to freeze: the
    // server's probe then finds the frozen socket alive and spares it as
    // incumbent, and the caller's own retries keep resetting the idle timeout
    // (the immortal-incumbent defect, client half).
    //
    // …unless a small-group session still holds the process awake: the
    // socket is ITS signalling path now, and its own end revisits this
    // decision (the `groupSessionKey` effect below).
    if (groupCall().view !== null) return;
    messaging.pause();
    // syncBadge KEEPS the old guard: it is a convenience (a fresh count after
    // a call), not the incident fix, and behind the lock it would read
    // conversation state (`db.unreadCounts`) at the two moments clearBadge's
    // contract says the count must not be computed — mid-relock with the db
    // closing, or mid-opening with the verdict not yet landed. It is entirely
    // local (SQLite → OS badge → app-group files, no network), so the guard
    // is about which workspace answers, not about silence.
    if (session.mode === 'real' && routeRef.current.name !== 'locked') {
      void syncBadge();
    }
  }, [call.name]);
  const media = localMediaState();

  // --- the small-group session ---------------------
  //
  // A sibling overlay like the 1:1 call, for the same reason: a call must
  // survive navigating to another chat. Everything below is NAMING and local
  // track mirroring — the session itself lives in the coordinator, and this
  // component only reads its published view and calls its methods.
  const groupView = useGroupCallState();
  const groupSessionKey = groupView?.sessionKey ?? null;
  const groupRoomId = groupView?.roomId ?? null;
  // THE PAUSE THAT BACKGROUNDING SKIPPED FOR A GROUP SESSION, taken when the
  // SESSION ends instead — the twin of the
  // `prevCallName` effect above, keyed on the session's opaque identity so a
  // glare swap (one session replaced by another) is not an end. Unconditional
  // for the same reasons that effect is; the 1:1 machine is consulted so two
  // shapes never pause under each other.
  const prevGroupSessionKey = useRef(groupSessionKey);
  useEffect(() => {
    const was = prevGroupSessionKey.current;
    prevGroupSessionKey.current = groupSessionKey;
    if (was === null || groupSessionKey !== null) return;
    if (callRef.current.name !== 'idle') return;
    const state = AppState.currentState;
    if (state !== 'background' && state !== 'inactive') return;
    messaging.pause();
  }, [groupSessionKey]);
  /** Names this phone holds for the session's roster. Only REAL names are
   * mapped: `personName`'s id fallback is refused here so it cannot reach a
   * tile, which the design forbids from ever showing an id. An unmapped member is
   * rendered as the honest placeholder by `CallTile`. */
  const [groupNames, setGroupNames] = useState<Map<string, string>>(new Map());
  /** The pictures beside those names — `chats.avatarB64`, the same column the
   * thread and the 1:1 arm's `callPeerAvatar` read (never a second source).
   * Folded in the same `listChats` pass as the names, so a tile cannot pair
   * one person's name with another person's photo. */
  const [groupAvatars, setGroupAvatars] = useState<Map<string, string>>(new Map());
  /** The room's own name and its folded roster — the second for the Add
   * picker, which may only offer people the room actually holds. */
  const [groupRoom, setGroupRoom] = useState<{
    roomId: string;
    name: string | null;
    members: string[];
  } | null>(null);
  const [groupCameraOn, setGroupCameraOn] = useState(
    () => groupSessionKey !== null && groupView?.video === true,
  );
  const [groupAdding, setGroupAdding] = useState(false);

  /**
   * SESSION UI IS RESET BEFORE ITS FIRST FRAME, not after it. A passive effect
   * let glare commit B once with A's camera choice and A's open Add sheet; the
   * unkeyed picker even carried A's selected people over the new roster.
   *
   * This is the dropped-banner rule from `GroupCallScreen`: effects run after
   * commit, so the identity comparison belongs at render. The coordinator's
   * incarnation key is used rather than a remotely reusable sid.
   */
  // Kept in state with the values it resets: an abandoned concurrent render
  // discards all of them together instead of leaving a ref pointing at a
  // session whose camera and picker reset never committed.
  const [previousGroupUiSessionKey, setPreviousGroupUiSessionKey] =
    useState(groupSessionKey);
  if (previousGroupUiSessionKey !== groupSessionKey) {
    setPreviousGroupUiSessionKey(groupSessionKey);
    const cameraOn = groupSessionKey !== null && groupView?.video === true;
    if (groupCameraOn !== cameraOn) setGroupCameraOn(cameraOn);
    if (groupAdding) setGroupAdding(false);
  }

  useEffect(() => {
    if (groupSessionKey === null) {
      setGroupNames(new Map());
      setGroupAvatars(new Map());
      return undefined;
    }
    let gone = false;
    void db
      .listChats()
      .then(chats => {
        if (gone) return;
        const map = new Map<string, string>();
        const avatars = new Map<string, string>();
        for (const c of chats) {
          const label = (c.localName ?? '').trim() || (c.displayName ?? '').trim();
          if (label) map.set(c.peerId, label);
          if (c.avatarB64) avatars.set(c.peerId, c.avatarB64);
        }
        setGroupNames(map);
        setGroupAvatars(avatars);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [groupSessionKey]);

  // RE-FOLDED WHEN THE PICKER OPENS, not once per room id.
  //
  // A call outlives room membership changes: somebody removed at minute three
  // was still in a list folded at minute zero, so the Add sheet went on
  // offering them. `groupAdding` is in the dependency list precisely so the
  // press that opens the sheet also re-asks the database — one read, on a
  // press a person just made.
  //
  // This is the UX half. The BOUNDARY is `addParticipant`, which folds the
  // room again at dial time and refuses a non-member: a picker is a screen,
  // and a screen can always be one render behind.
  useEffect(() => {
    if (!groupRoomId) {
      setGroupRoom(null);
      return undefined;
    }
    let gone = false;
    void Promise.all([
      db.getGroup(groupRoomId).catch(() => null),
      db.getChat(groupRoomId).catch(() => null),
      db.listGroupMemberSlots(groupRoomId).catch(() => []),
    ])
      .then(([group, chat, slots]) => {
        if (gone || !group) return;
        // The same fold the room thread and the send path act on, so
        // the Add picker cannot offer someone who has left.
        const fold = foldRoster(group.ownerId, slots);
        setGroupRoom({
          roomId: groupRoomId,
          name:
            (chat?.localName ?? '').trim() || (group.name ?? '').trim() || null,
          members: [...fold.members],
        });
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [groupRoomId, groupAdding]);

  /** Room members who are not already on the call — the only people an Add
   * may offer. A previous room's fold stays committed while the next read is
   * pending or fails, so it owns this display only when its room still does.
   * The dial boundary remains `addParticipant`'s fresh fold; this prevents the
   * picker from showing the wrong room, not a boundary bypass. */
  const groupAddCandidates =
    groupRoom && groupView && groupRoom.roomId === groupRoomId
      ? groupRoom.members.filter(id => !groupView.roster.includes(id))
      : [];

  const [profile, setProfile] = useState<db.ProfileRow | null>(null);
  const [deletionPending, setDeletionPending] = useState(false);
  const [identityMissing, setIdentityMissing] = useState(false);
  const [freshStartConfirm, setFreshStartConfirm] = useState(false);
  const [deletionBusy, setDeletionBusy] = useState(false);
  const deletionActionRunning = useRef(false);
  // The naming moment: armed by a registration that just
  // succeeded, spent by the step's own Continue or Not now. In memory on
  // purpose — a process that dies in between leaves the account nameless
  // and unsettled, which is exactly what the chat list's one-time nudge is
  // for. NOT a route: it is the home surface's first-run state, so every
  // fact the visible-surface module states for 'chats' holds for it
  // unchanged (covered during capture, workspace open, no conversation
  // content) and no fifth consumer of the facts was added. A named account
  // (a recovery that restored one) is never asked.
  const [namingPending, setNamingPending] = useState(false);
  const namingStep =
    namingPending && profile !== null && profile.displayName === '';
  const [appActive, setAppActive] = useState(
    () =>
      AppState.currentState !== 'background' &&
      AppState.currentState !== 'inactive',
  );
  const reduceMotion = useReduceMotion();
  const routeRef = useRef(route);
  routeRef.current = route;
  const settingsBackHandlerRef = useRef<(() => boolean) | null>(null);

  // --- the wide projection's derived facts ---------
  //
  // ALL of these derive from the route — the projection adds NO state of its
  // own, which is what "a projection, never a second router" means: the same
  // `route` renders one pane on a phone and two on a wide window, and every
  // navigation still moves through setRoute.

  /** Which home tab the LIST pane shows in wide: the open surface's own
   * origin, the same `from` its Back control reads — so the list beside a
   * Calls-origin thread is the Calls list its chevron would pop to. */
  const listTab: 'chats' | 'calls' =
    route.name === 'calls' || ('from' in route && route.from === 'calls')
      ? 'calls'
      : 'chats';
  /** The conversation the open detail surface is ABOUT — the list pane's
   * highlight (`selectedPeerId`). A room's conversation row IS its ULID, so groupProfile highlights through groupId. In
   * compact this is only ever read while the list itself is the route,
   * where no detail is open and it is undefined by construction. */
  const selectedPeerId =
    route.name === 'thread' ||
    route.name === 'peerProfile' ||
    route.name === 'photoViewer'
      ? route.peerId
      : route.name === 'groupProfile'
        ? route.groupId
        : undefined;
  /** Two panes: an expanded window over an OPEN workspace on a projected
   * route. Without a profile there is no list to pane (and no state that
   * needs one — settings/photoViewer render without a profile only on paths
   * a workspace closure is already tearing down). */
  const projected =
    windowClass === 'expanded' &&
    profile !== null &&
    PANE_PROJECTED.has(route.name);
  /** In the projection the two home routes mean "list beside the empty
   * detail"; every other projected route is an open detail surface. */
  const detailOpen = route.name !== 'chats' && route.name !== 'calls';
  /** A third of the pane area — the window minus its horizontal insets
   * — held to the token bounds (the
   * list pane is 320–360pt). */
  const listPaneWidth = Math.min(
    t.layout.windowClass.listPaneMax,
    Math.max(t.layout.windowClass.listPaneMin, Math.round(paneAreaWidth / 3)),
  );

  // THE VISIBLE SURFACE, as a first-class fact: the
  // route PLUS the overlay siblings, never route.name alone — the call
  // surfaces render over any route and start before the lock verdict by
  // design, so "what is on glass" is never just the route. The four security
  // consumers (screenshot disclosure, the capture-cover exemption,
  // preview-lease renewal, push-nav redemption) read these derived facts
  // instead of route-name strings; the wide projection feeds one
  // entry per visible pane into the SAME derivation — the consumers did not
  // change — the point being that with a thread open in wide the
  // surface is [{chats}, {thread}], and a screenshot still discloses to the
  // visible thread even though a route named 'chats' is on glass beside it.
  // The fix (as amended) lives in the model: any live call
  // overlay is coverable, whatever route sits behind it.
  const surfaceFacts = deriveSurfaceFacts(
    projected
      ? wideVisibleSurface({ name: listTab }, detailOpen ? route : null, {
          call,
          groupCall: groupView,
        })
      : compactVisibleSurface(route, { call, groupCall: groupView }),
  );
  // Mirrored into a ref for the same reason routeRef is: the screenshot
  // listener and the AppState listener are created once and read the facts
  // at event time.
  const surfaceFactsRef = useRef(surfaceFacts);
  surfaceFactsRef.current = surfaceFacts;

  // Subscribe to call envelopes and register for VoIP wakes. Without the
  // registration the server has no token to wake this device with, so a call
  // to a backgrounded phone never rings at all.
  //
  // AT MOUNT, DELIBERATELY, AND THEREFORE BEFORE THE VERDICT. This effect is
  // declared above the lock effect below, so React runs it first, and
  // `startCalling` runs synchronously into its body before any await in that
  // effect resolves. That is correct for the ring — a phone must be wakeable
  // whether or not anyone has typed a code — and it is why `startCalling` no
  // longer opens a workspace or talks to our server: that half is
  // `adoptWorkspaceForCalling`, called from the two unlock arms below. Do not
  // "fix" a leak here by moving or delaying this effect; the verdict is async,
  // so reordering does not remove the window, and delaying it is a denial of
  // ring.
  useEffect(() => {
    let teardown: (() => void) | undefined;
    void startCalling().then(fn => {
      teardown = fn;
    });
    return () => teardown?.();
  }, []);
  /** Read by refreshProfile, which must stay identity-stable so the messaging
   * subscription is not torn down and re-armed on every profile change. */
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const backgroundedAt = useRef<number | null>(null);
  /** One revocable authority for every path that can open a workspace: cold
   * boot, a real unlock, and a duress unlock. A foreground status failure
   * advances the generation synchronously, then waits for the invalidated
   * task before performing the final full relock. */
  const openingGeneration = useRef(0);
  // Explicit opening/teardown authority. A stale registration callback must
  // not rearm access while a relock is still awaiting call shutdown.
  const writingWorkspaceReady = useRef(false);
  const writingForegroundEpoch = useRef(0);
  useEffect(() => {
    setWritingForeground(AppState.currentState === 'active');
    return () => invalidateWritingSession();
  }, []);
  const activeOpening = useRef<{
    generation: number;
    task: Promise<void>;
  } | null>(null);
  const failClosedRelock = useRef<Promise<void> | null>(null);
  const openingIsCurrent = useCallback(
    (generation: number) => openingGeneration.current === generation,
    [],
  );

  /** The policy the update wall renders from, held as state so a re-check
   * that changes the operator's message repaints. The gate itself is the
   * module singleton — this is a copy for the screen, never a second
   * source of the decision. */
  const [updatePolicy, setUpdatePolicy] = useState<
    ClientPolicyResponse | undefined
  >(undefined);
  /** Ask the gate, and bring the answer back into React. Every one
   * of the three check points goes through here, so "what did we ask, and
   * what did we do about it" is one function rather than three. */
  const checkForUpdate = useCallback(async (reason: CheckReason) => {
    const decision = await updateGate.checkNow(reason);
    setUpdatePolicy(updateGate.policy);
    return decision;
  }, []);
  /** What "Check again" is doing, for the wall to say so. `stillOld` is the
   * settled acknowledgement a recheck that changes nothing owes the person
   * who pressed: without it the only control on the screen looks dead. */
  const [updateRecheck, setUpdateRecheck] = useState<
    'idle' | 'checking' | 'stillOld'
  >('idle');
  /** The same acknowledgement at check point 1. "Get started" runs a network
   * check before registration begins, and until this flag existed it ran it
   * behind a button that looked untouched — so a slow link read as a dead
   * door and invited a second press. */
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  /**
   * TAKE THE WORKSPACE DOWN BEHIND THE WALL.
   *
   * The gate describes the wall as a route with nothing running behind it, and
   * the boot check point earns that by returning before `messaging.start`.
   * Neither of the two other ways to reach the wall did. Foregrounding into
   * a raised floor left the socket open, the previews armed and the push
   * tokens registered, so a build the server had just declared too old went
   * on syncing and went on ringing for calls it could not complete, under a
   * screen telling its owner it could no longer connect. And the boot path
   * had already registered this device and armed the lease several steps
   * ABOVE the gate, so even there the wall's promise was only half kept.
   *
   * This is `relock()`'s teardown minus the parts that belong to a verdict:
   * no `db.close`, no `session.setMode`, no route. "Check again" reopens
   * through `beginWorkspaceOpening('real')`, which closes and reopens the
   * database itself.
   */
  const quiesceForUpdateWall = useCallback(async () => {
    writingWorkspaceReady.current = false;
    invalidateWritingSession();
    // First, and synchronously: everything below awaits, and an APNs
    // rotation landing in that window must not re-register a build that is
    // about to be walled off. Nothing is withdrawn, only withheld.
    adoptPushRegistration({ real: false });
    await endCallOnQuiesce();
    messaging.stop();
    disposeGroupCall();
    quiesceCallMetrics();
    await disarmPreviews().catch(() => undefined);
  }, []);

  /** Open the real workspace: the normal boot, and the 'real' verdict. */
  const enterRealWorkspace = useCallback(async (generation: number) => {
    writingWorkspaceReady.current = false;
    invalidateWritingSession();
    try {
      // Fence any continuation from the session/workspace that just ended
      // before this path closes or reopens SQLite. Ahead of `beginUnlock`
      // because that is what re-points the door: this call is synchronous by
      // contract precisely so the revocation lands before the declaration.
      quiesceCallMetrics();
      // FIRST LINE, BEFORE ANY AWAIT, AND ON BOTH ARMS. Everything below this
      // is asynchronous, and the pre-verdict door in db.ts is by design not
      // stopped by the closed latch — so until the db module is told which
      // world was chosen, a CallKit press landing anywhere in this function
      // lazily opens whatever `workspace` still happens to say. On this arm
      // that is already 'real' and nothing changes; the line is here because
      // the DECOY arm's version of it is load-bearing, and a declaration on
      // one arm of a twin only is the exact defect this file keeps growing.
      //
      // AND IT IS NOW UNENFORCEABLE, WHICH IS RECORDED RATHER THAN HIDDEN.
      // When it was added it was load-bearing on one path — a duress session
      // left `workspace === 'decoy'` and relock did not touch it, so this line
      // was what pointed the door back. `relock()` now resets the pointer
      // itself (`db.relockWorkspace()`), which is what the LOCKED-IDLE window
      // needed and which this line could never have reached, and the DECOY
      // arm's catch spends the declaration the same way when the attempt dies
      // — so between them there is no reachable state where `pendingWorkspace`
      // is anything but null or 'real' when this arm starts. Deleting it keeps
      // the whole suite green (re-verified this round); it is kept as the
      // declared half of a twin and as the defence that survives if either
      // reset is ever moved, not as a live guard.
      //
      // "UNENFORCEABLE" MEANS IN PRODUCTION, AND THE REST OF THE SENTENCE HAS
      // TO SAY SO. What the line overrides is `workspace`, not just a stale
      // `pendingWorkspace`, and `workspace` DOES read 'decoy' on one path that
      // ships: `TacendumDevUnlock` (__DEV__, below) calls `applyVerdict`
      // directly rather than through `<LockScreen>`, so a 'real' verdict can
      // be applied while a duress session is still open — which is exactly
      // what scripts/app-verify.sh does. On that path a CallKit press
      // landing anywhere in this function would resolve the DECOY without this
      // line, and be released as `failed_media`. It is dead in production
      // because `applyVerdict` is otherwise reachable only at
      // `route === 'locked'`, which `relock()` has already pointed back at
      // 'real'; it is live in a dev build, and no test pins it because a test
      // that reached that state would be pinning a state production cannot
      // reach.
      db.beginUnlock('real');
      session.setMode('real');
      // A durable deletion intent wins over token healing, push registration,
      // and identity restoration. It is read only AFTER the real unlock.
      // A refused marker read also holds this gate closed until a retry.
      const pendingDeletion = await hasPendingAccountDeletion().catch(() => true);
      if (!openingIsCurrent(generation)) return;
      if (pendingDeletion) {
        adoptPushRegistration({ real: false });
        await db.close();
        if (!openingIsCurrent(generation)) return;
        db.setWorkspace('real');
        await db.initDb();
        if (!openingIsCurrent(generation)) return;
        let unfinished = false;
        try { await deleteAccount(); } catch { unfinished = true; }
        const missingIdentity = unfinished && !(await hasIdentity().catch(() => true));
        if (!openingIsCurrent(generation)) return;
        setDeletionPending(unfinished);
        setIdentityMissing(missingIdentity);
        writingWorkspaceReady.current = !unfinished;
        setRecoveryIntent(false);
        setProfile(null);
        setRoute({ name: 'landing' });
        return;
      }
      // A duress session may have flipped the blank setting in memory; the
      // real session re-reads the persisted truth.
      await screenSecurity.reloadSetting();
      if (!openingIsCurrent(generation)) return;
      // Same rule, same place: re-read on every REAL unlock so a duress
      // session's value can never bleed into a real one.
      await loadReadReceipts();
      if (!openingIsCurrent(generation)) return;
      await loadTypingIndicators();
      if (!openingIsCurrent(generation)) return;
      await loadPreviewLevel();
      if (!openingIsCurrent(generation)) return;
      // The push-consent re-read, and the reason it belongs in THIS list rather than
      // only at boot: without a re-read on real unlock, a duress session's
      // in-memory value would outlive it, and the two directions fail
      // differently. A duress "off" bleeding into a real session silently
      // stops calls ringing a locked phone; a real "off" surviving into a
      // duress session is harmless. Re-reading closes the first.
      await loadPushConsent();
      if (!openingIsCurrent(generation)) return;
      // THE VERDICT, TOLD TO THE PUSH PATH — and the earliest honest moment
      // for it.
      //
      // Immediately AFTER the consent re-read above, which is the one thing it
      // must not overtake: consent defaults to allowed in memory, so
      // registering first would re-upload a row the owner had withdrawn.
      //
      // And BEFORE everything below, which is the point. `armPreviews`,
      // `db.close`, `setWorkspace` and `initDb` can all throw, and a throw
      // among them lands in the catch below — so hanging the registration off
      // the far side of them meant one unrelated failure left this device with
      // no push token for the whole launch, i.e. a phone that silently stops
      // ringing. The registration needs no workspace and no profile: both
      // tokens come from iOS and the bearer from the Keychain.
      //
      // Cheap and idempotent server-side; the merge rule means a success can
      // only ever add tokens, never lose one.
      adoptPushRegistration({ real: true });
      // The app-wide switch, in this list for the same reason as the two
      // above: it is a Keychain preference a duress session can move in
      // memory, and the real session must be told the truth again. The
      // per-person memory needs no line here — it lives in the workspace
      // database, so opening the real file IS the re-read.
      await loadAlwaysRelay();
      if (!openingIsCurrent(generation)) return;
      // The silence-unknown-callers, and it belongs in this list for a
      // sharper version of the reason above: the duress default and the real
      // owner's choice can differ, and the direction that matters is a duress
      // session's value outliving it. Someone who turned silencing OFF in a
      // real session must not find the phone silently ignoring a caller
      // because a coerced unlock happened first — and a real session that had
      // it on must not inherit a decoy's anything. Re-reading closes both.
      await loadSilenceUnknownCallers();
      if (!openingIsCurrent(generation)) return;
      // Previews are armed by a REAL session opening and by nothing else. The
      // marker's absence is the safe state, so this is the only place in the
      // app that may create it.
      //
      // CAUGHT, and the catch is the point. This throws when the App Group
      // container is unavailable, and it sits inside a try whose handler
      // decides whether the account needs healing — so an unrelated
      // entitlement problem would present as "this phone has no profile" and
      // send someone to the landing screen with their conversations intact but
      // invisible. Failing to arm costs previews and nothing else.
      await armPreviews().catch(() => undefined);
      if (!openingIsCurrent(generation)) return;
      // Defensive: heal any handle a stray callback may have resurrected —
      // setWorkspace must never throw over a routine unlock.
      await db.close();
      if (!openingIsCurrent(generation)) return;
      db.setWorkspace('real');
      await db.initDb();
      if (!openingIsCurrent(generation)) return;
      const existing = await db.loadProfile();
      if (!openingIsCurrent(generation)) return;
      // A profile whose identity key is GONE must not start a session that
      // cannot decrypt anything. With a live token this state used to sail
      // straight through — socket up, everything green, every message an
      // error — because the heal gate only catches the token-absent variant.
      // Landing is where "Get started" lives, and that runs
      // createOrRestoreAccount, which throws the terminal IdentityLostError
      // with the honest copy. Nothing is wiped on the way there.
      if (existing) {
        const identityPresent = await hasIdentity().catch(() => true);
        if (!openingIsCurrent(generation)) return;
        if (!identityPresent) {
          setIdentityMissing(true);
          setProfile(null);
          setRoute({ name: 'landing' });
          return;
        }
      }
      if (existing) {
        if (!openingIsCurrent(generation)) return;
        setProfile(existing);
        // CHECK POINT 2, and the load-bearing one:
        // after the profile read, so a phone with no account never dials
        // this on the way to the landing screen, and STRICTLY BEFORE the
        // workspace-shaped work below: a blocked build must reach neither
        // the call adoption (which registers this device) nor
        // `messaging.start` (which opens the socket). Never on the locked
        // route, because this whole function runs after the verdict; never
        // in duress, because `checkNow` returns before it can dial.
        //
        // WHAT IT CANNOT WITHHOLD BY SITTING HERE, AND SO UNDOES INSTEAD.
        // Three workspace-shaped things run ABOVE this line and have to:
        // the push registration (whose whole argument is that it must not
        // hang off anything that can throw), the preview lease, and the
        // database. The wall's "push adoption stays off, no socket is opened"
        // was therefore only true of the socket. The blocked arm now spends
        // the first two back, so a walled build stops being woken by VoIP
        // pushes for calls it cannot take.
        const gate = await checkForUpdate('enterWorkspace');
        if (!openingIsCurrent(generation)) return;
        if (gate === 'blocked') {
          await quiesceForUpdateWall();
          if (!openingIsCurrent(generation)) return;
          setUpdateRecheck('idle');
          setRoute({ name: 'updateRequired' });
          return;
        }
        // THE VERDICT'S OTHER HALF. `startCalling` armed the ring at mount and
        // deliberately touched nothing that needed a workspace; this is where
        // the workspace-shaped work lands, now that "which world" has an
        // answer. It reconciles crashed call rows, prunes expired offers and
        // sessions, and re-reads who this device is. See
        // `adoptWorkspaceForCalling` for why every step is on both arms.
        //
        // AFTER THE IDENTITY GATE, INSIDE `if (existing)`, WHICH IS WHERE THE
        // READ IT REPLACED SAT. Run above the gate it told the group-call
        // coordinator this device was registered — and prunes rows out of a
        // workspace — on the way to the landing screen of a phone whose
        // identity keypair is gone, i.e. an account that cannot decrypt
        // anything and is about to be healed or abandoned.
        //
        // AWAITED, AND BEFORE THE SOCKET, because the id read inside it is.
        // Fired with `void`, that read raced the very delivery it exists to
        // serve: `messaging.start` brings the socket up and can hand the
        // coordinator a `ginvite` while the profile read is still in flight,
        // and `handleInvite` returns at `if (!selfId)` — dropped before
        // admission, before the push placeholder is dismissed, before any row
        // is written. Nobody is told and nothing retries. It cannot reject
        // (every step swallows its own failure), so ordering is the whole fix.
        await adoptWorkspaceForCalling();
        if (!openingIsCurrent(generation)) return;
        await messaging.start(existing.userId);
        if (!openingIsCurrent(generation)) return;
        await activateCallMetricDrainForWorkspace();
        if (!openingIsCurrent(generation)) return;
        // A STARTED recovery survives the relaunch through its durable
        // `recovery_local` row:
        // the recover surface is re-entered HERE, at boot — an ordinary
        // opening under the fix-pass (a′) rule, kept now that the
        // Settings entries have landed — so a launch mid-wait lands back
        // on the pending screen (back goes to chats; "set aside" clears
        // the row, so this routing self-retires). A push-tap below still
        // outranks it: an explicit navigation intent wins the landing.
        // Routed through `recoveryRowVisible`:
        // a kind='phone' row in a false-pin binary must not reopen the
        // recover surface — the row survives, dark, for the pin-ON
        // binary; the ordinary chats landing wins meanwhile.
        const pendingRecovery = await db.loadLocalRecovery().catch(() => null);
        if (!openingIsCurrent(generation)) return;
        setWritingAccess(existing.userId);
        writingWorkspaceReady.current = true;
        if (recoveryRowVisible(pendingRecovery)) {
          setRoute({ name: 'recover', from: 'chats' });
        } else {
          setRoute({ name: 'chats' });
        }
        // The banner tap's redemption, strictly AFTER
        // the verdict honoured above and after chats mounted, so Back lands
        // where it always lands. The intent is a bare row key with a TTL
        // (src/pushnav.ts) — a tap through the lock screen arrives here
        // through the SAME unlock as any other launch, and a pending
        // approval in the tapped thread is already the focused element by
        // the synthetic-row injection: the thread opens scrolled to
        // its newest rows, where the card lives.
        const tapped = await consumePendingNav();
        if (!openingIsCurrent(generation)) return;
        if (tapped) setRoute({ name: 'thread', peerId: tapped });
      } else {
        if (!openingIsCurrent(generation)) return;
        writingWorkspaceReady.current = true;
        setProfile(null);
        setRoute({ name: 'landing' });
      }
    } catch {
      if (!openingIsCurrent(generation)) return;
      // ONE state is diagnosed here rather than treated as transient: a
      // profile on disk whose Keychain auth token is gone. `messaging.start`
      // throws precisely then ("no auth token"), so this is the common way
      // into this catch. Never log — the error may reference stored data.
      //
      // THIS USED TO WIPE, AND THE WIPE WAS ACCOUNT-DESTROYING under keypair
      // accounts. It was right for phone accounts:
      // profile and token were written together, so one without the other was
      // an inconsistent half-state, and re-registering a phone number
      // recovered the same userId anyway. Under keypair accounts every clause
      // of that is false. `clearLocalState()` deletes the profile but CANNOT
      // touch the protocol store — the identity keypair lives in the native
      // stores and the Keychain, neither of which is local state — so the next
      // sign-up would see keys with no profile, mint a FRESH keypair, and the
      // server's `idkey#` claim row would make that a DIFFERENT account: the
      // old userId unreachable, every peer's safety number broken, and by
      // design (cost table row 3) nothing to recover it with.
      //
      // The honest reading is the opposite one. A surviving identity with a
      // surviving profile and a missing token is not damage — it is exactly
      // the state `createOrRestoreAccount` exists to heal: challenge, sign
      // with the SAME identity key, and the server hands back the SAME userId
      // ("known key → look up"). So: re-authenticate, keep everything.
      let healable = false;
      try {
        healable =
          (await db.loadProfile()) !== null &&
          !(await getSecret(AUTH_TOKEN_KEY));
      } catch {
        healable = false;
      }
      if (!openingIsCurrent(generation)) return;
      if (healable) {
        try {
          const healed = await createOrRestoreAccount();
          if (!openingIsCurrent(generation)) return;
          setProfile(healed);
          // The start remains best-effort — the stored profile can report
          // Offline honestly — but its whole continuation now belongs to this
          // opening. Detached, its finally could route Chats after a later
          // foreground status failure had already relocked the app.
          try {
            await messaging.start(healed.userId);
            if (!openingIsCurrent(generation)) return;
            await activateCallMetricDrainForWorkspace();
          } catch {
            // Offline is a settled opening, not a reason to strand loading.
          }
          if (!openingIsCurrent(generation)) return;
          // The same started-recovery re-entry as the ordinary opening
          // — a heal must not strand a pending wait.
          const healedPendingRecovery = await db.loadLocalRecovery().catch(() => null);
          if (!openingIsCurrent(generation)) return;
          setWritingAccess(healed.userId);
          writingWorkspaceReady.current = true;
          if (recoveryRowVisible(healedPendingRecovery)) {
            setRoute({ name: 'recover', from: 'chats' });
          } else {
            setRoute({ name: 'chats' });
          }
          return;
        } catch {
          if (!openingIsCurrent(generation)) return;
          // Offline, or the server refused. NOTHING has been destroyed, which
          // is the point: fall through to the landing screen, where "Get
          // started" runs the same heal again — `createOrRestoreAccount`
          // reuses the stored identity and the stored profile, so it is a
          // retry, not a second account.
        }
      }
      if (!openingIsCurrent(generation)) return;
      setProfile(null);
      let lockEnabled: boolean;
      try {
        lockEnabled = (await lock.status()).enabled;
      } catch {
        // The coordinator turns this sentinel into the same generation
        // invalidation and full relock as boot/foreground status failures.
        return 'lock-status-rejected' as const;
      }
      if (!openingIsCurrent(generation)) return;
      writingWorkspaceReady.current = !lockEnabled;
      setRoute(lockEnabled ? { name: 'locked' } : { name: 'landing' });
    }
  }, [checkForUpdate, openingIsCurrent, quiesceForUpdateWall]);

  /** Open the decoy workspace: the 'duress' verdict.
   * Messaging is never started — the session is network-silent. */
  const enterDecoyWorkspace = useCallback(async (generation: number) => {
    writingWorkspaceReady.current = false;
    invalidateWritingSession();
    try {
      // Fence the outgoing session's metric authority FIRST, and on this arm
      // that is the fix rather than the symmetry too. The lifecycle heartbeat
      // is a 30-second `setInterval` that WRITES SQLITE; left armed across the
      // declaration below it becomes another way for a real session to reach
      // through a decoy verdict — the same defect the next comment describes,
      // arriving through a door opened after that comment was written.
      quiesceCallMetrics();
      // THE TWIN OF THE FIRST LINE IN `enterRealWorkspace`, and on this arm it
      // is the fix rather than the symmetry. Every step below awaits, the
      // pre-verdict door is deliberately not stopped by the closed latch, and
      // `workspace` still reads 'real' until `setWorkspace` runs — so before
      // this line a lock-screen press landing anywhere in this function opened
      // `tacendum.sqlite` in front of the person being coerced, read the last
      // group call's roster out of it, DELETEd its offer rows, and left a
      // handle open that made `setWorkspace('decoy')` throw the whole arm into
      // its catch. Declaring the verdict costs nothing and closes the window
      // at its source: from here on, that press reaches the decoy.
      db.beginUnlock('decoy');
      // AND SYNCHRONOUSLY, FOR THE SAME REASON. `selfAccountId` is a
      // process-lifetime latch that the pre-verdict door can set from the REAL
      // profile (`learnSelfIdForRingService`), and the only thing that resets
      // it is `adoptWorkspaceForCalling` at the BOTTOM of this arm —
      // downstream of every throw source in it. Forgetting first means a
      // coerced session cannot be told the real owner's ULID by an arm that
      // died on the way, and the re-read below still puts the decoy's own
      // answer back. Not mirrored on the real arm: there the latch is about to
      // be overwritten from the workspace the verdict just legitimised, and
      // blanking it would pull the id out from under an in-flight cold answer
      // that the real verdict has just made valid.
      setSelfAccountId(null);
      session.setMode('duress');
      // As in enterRealWorkspace, the verdict also gates push registration.
      // Duress allows no socket, REST call or push registration. `api.ts`
      // refuses everything from the line above onward, so this is belt over
      // braces — but it is the belt that matters on a RELOCK into duress,
      // where the latch is still true from the real session that just ended
      // and an APNs rotation mid-coercion would otherwise find an open gate.
      adoptPushRegistration({ real: false });
      // Show the default, not the owner's persisted choice.
      screenSecurity.resetForDuress();
      resetReadReceiptsForDuress();
      resetTypingIndicatorsForDuress();
      resetPreviewLevelForDuress();
      // The one with the most to give away: Off in that row says this phone
      // deleted the token that wakes it, which is a fact about the OWNER, and
      // a coercer can read it in a glance. The module keeps a session-scoped
      // shadow rather than the real value, and this is what puts the shadow
      // back to the shipped default for each new coerced session.
      resetPushConsentForDuress();
      // Costs nothing to hide: the decoy file has no call history, so every
      // peer in a duress session reads as never-called and the first-call
      // default relays regardless of what this says.
      resetAlwaysRelayForDuress();
      // Same rule, and here the default is also the quieter answer: a decoy
      // workspace has no message history, so every caller in it is unknown,
      // and a phone that stays silent while somebody is standing over it
      // discloses nothing about who was trying to reach its owner.
      resetSilenceUnknownCallersForDuress();
      // Last of the eight, because Field Mode is the composite of four of
      // them: its shadow is what a coerced On or Off moves, and starting a
      // session from the previous coercer's taps would show them a state
      // nobody in this session put there. The module resets that shadow
      // lazily on its first read as well; resetting here also makes the
      // workspace boundary explicit before any setting is read.
      resetFieldModeForDuress();
      // FIRST, and awaited: while this marker exists the extension may render
      // a real message's contents, and a duress session must not be able to do
      // that.
      //
      // But it must not be able to STOP the decoy opening either. Somebody is
      // standing over this phone; landing on the landing screen because a file
      // would not unlink tells them the passcode did something unusual.
      // `disarmPreviews` already tries twice internally — delete, then
      // overwrite — so reaching this catch means both routes failed, and the
      // remaining move is to proceed into the decoy.
      await disarmPreviews().catch(() => undefined);
      if (!openingIsCurrent(generation)) return;
      // Second, independent stop: without a local address the extension has
      // nothing to decrypt with, whatever the armed marker says. A duress
      // session must not be able to spool the real owner's plaintext.
      await retractSelfId().catch(() => undefined);
      if (!openingIsCurrent(generation)) return;
      // Cleared BEFORE the decoy opens, not synced after it. The icon is
      // currently showing the REAL workspace's unread count, and every failure
      // path below — including the catch — must not leave that number on
      // screen. Zero first, then the decoy's own count once its database is
      // open; a badge that briefly reads 0 is not evidence of anything, and a
      // badge still reading 7 after a duress unlock is.
      await clearBadge();
      if (!openingIsCurrent(generation)) return;
      await db.close();
      if (!openingIsCurrent(generation)) return;
      // THE SWITCH SITS IMMEDIATELY AFTER THE CLOSE, WITH NO AWAIT BETWEEN
      // THEM, and the drift moved below it. In the other order the module
      // spent the whole of `refreshDecoyTimestamps` — one SELECT and, on a
      // populated decoy, six UPDATEs — saying `workspace === 'real'` with no
      // handle open, which is precisely the state the pre-verdict door lazily
      // opens the REAL file from. Ordering alone would not have been enough
      // (the awaits above this line have the same shape), which is why
      // `beginUnlock` is at the top; but with a `close()` that can no longer
      // be followed by a window, `setWorkspace` can no longer be made to throw
      // by a press, and the arm can no longer be dropped into its catch that
      // way. The drift still runs before the workspace OPENS, which is the
      // only thing the design requires of it.
      db.setWorkspace('decoy');
      // SWALLOWED, like `disarmPreviews` and `retractSelfId` above. Only the
      // drift's opening SELECT is guarded internally ("fresh file, no decoy
      // yet"); the six UPDATEs behind it are not, and they run on exactly the
      // decoys a duress unlock is performed on. A cosmetic timestamp shift
      // that fails must not be able to show the person being coerced the
      // landing screen — a passcode that visibly did something unusual is the
      // one outcome this whole feature exists to avoid.
      await refreshDecoyTimestamps().catch(() => undefined);
      if (!openingIsCurrent(generation)) return;
      await db.initDb();
      if (!openingIsCurrent(generation)) return;
      // The twin of the line in `enterRealWorkspace`, and it must be here or
      // this arm inherits the real session's answers: the decoy reconciles its
      // OWN crashed call rows and re-reads its OWN id, so `selfAccountId`
      // cannot stay pointed at the real owner's ULID for the rest of the
      // process — including when a pre-verdict lock-screen answer put it there
      // (`learnSelfIdForRingService`). No identity gate on this arm, so it
      // sits where the real arm's sits relative to the profile read.
      await adoptWorkspaceForCalling();
      if (!openingIsCurrent(generation)) return;
      const existing = await db.loadProfile();
      if (!openingIsCurrent(generation)) return;
      setProfile(existing);
      setRoute(existing ? { name: 'chats' } : { name: 'landing' });
      // A tap intent is a REAL-workspace fact: never honoured here — the
      // decoy cannot explain a thread its database does not hold — and
      // consumed UNREAD so it cannot outlive the coerced session and
      // teleport a later real unlock into a conversation the tap stopped
      // being about. Fire-and-forget, like everything cosmetic on this arm:
      // nothing about navigation may gate the decoy opening.
      void consumePendingNav();
      void syncBadge();
    } catch {
      if (!openingIsCurrent(generation)) return;
      // THE VERDICT IS SPENT EVEN THOUGH IT WAS NEVER HONOURED, and this line
      // is the twin of the one in `relock()`. Reaching here means no decoy
      // session exists — nothing opened, no messaging, no coordinator, "Get
      // started" on screen — but the declaration made on the arm's first line
      // is still standing, and until this the ONLY thing that cleared it was a
      // relock, which needs a background→foreground cycle that may never come.
      // So every lock-screen answer between a failed coercion and the next
      // foregrounding resolved the EMPTY DECOY and was released as
      // `failed_media`: the same denial of ring the relock reset was added to
      // end, on the arm that never got there.
      //
      // It also re-latches the db module, which is what makes moving the
      // pointer safe when the arm died BELOW `initDb()` — see `relockWorkspace`.
      //
      // Nothing is closed here, and the reason written here before was FALSE
      // in a way that mattered: "a close cuts an in-flight press". It did —
      // and so did the `await db.close()` two dozen lines above, on this same
      // arm, which is the closer a lock-screen press actually meets when
      // somebody types the duress passcode on a ringing phone. Naming the cut
      // as a reason to skip one close while the arm's other close performed it
      // is the same shape as the comment `relockWorkspace` carried. Neither
      // cuts anything now (`doorStatementsRunning` in db.ts holds a release
      // off a door statement until it has answered); nothing is closed here
      // because this function has no session and no handle of its own to
      // close.
      db.relockWorkspace();
      // Never wipe anything from a duress path — land somewhere plausible.
      setProfile(null);
      setRoute({ name: 'landing' });
    }
  }, [openingIsCurrent]);

  /** Relock: quiesce in order — end any live call, stop messaging, close the
   * db — so the next verdict can switch workspaces safely. */
  const relock = useCallback(async () => {
    writingWorkspaceReady.current = false;
    invalidateWritingSession();
    // Revoke every boot/unlock continuation before the first await. Route is
    // not authority: both loading and locked remain visible while an opening
    // is in flight, so only this generation can make its later work stale.
    openingGeneration.current += 1;
    // FIRST, AND SYNCHRONOUSLY, because everything below this line awaits. A
    // locked app has no verdict, and the verdict it had is spent: the push
    // gate goes back to where a launched process finds it. Without this, a
    // phone sitting locked still had an open gate, so an APNs token rotation
    // — which arrives whether or not anybody is looking at the phone — would
    // register the real account from behind the lock screen, and would keep
    // doing so through the whole window before a DURESS unlock, where the
    // decoy arm's own reset arrives too late to have stopped it.
    //
    // Not a denial of ring: the registration is re-offered the instant a real
    // verdict lands (`adoptPushRegistration`), and the token the server
    // already holds is untouched — nothing is withdrawn here, only withheld.
    adoptPushRegistration({ real: false });
    // A live 1:1 call cannot outlive its signalling path, and the next line
    // kills that path. Ended FIRST, through the reducer's own terminal
    // funnel, so the peer is told while the transport still accepts the
    // frame, the CXCall is released rather than left on the lock screen
    // undriveable, the microphone dies with the workspace, and the log row
    // lands before the db closes. The argument for ending rather than
    // carrying the call across the lock — including why duress REQUIRES
    // this — is at `endCallOnQuiesce` (src/call/index.ts).
    await endCallOnQuiesce();
    messaging.stop();
    // The small-group session goes with the socket, and for the same reason
    // messaging stops here: whatever workspace opens next must not
    // inherit a live roster, N leg services or an armed re-offer timer from
    // the session that was running before the lock. A duress unlock is the
    // case that matters — a timer firing into it would reach native media
    // creation in a session that is supposed to be silent.
    disposeGroupCall();
    // The terminal 1:1 metric above must persist while SQLite is still open;
    // after both call shapes are down, revoke every remaining metric timer
    // and callback before any asynchronous relock work or database close.
    quiesceCallMetrics();
    // A locked app is not a real session. Disarming here is what makes the
    // marker mean "someone is currently signed in on this device" rather than
    // "someone signed in once", and it is what stops a phone locked and left
    // on a desk from previewing anything.
    await disarmPreviews().catch(() => undefined);
    await retractSelfId().catch(() => undefined);
    try {
      await db.close();
    } catch {
      // the switch guard in setWorkspace still protects us
    }
    // THE VERDICT IS SPENT, TOLD TO THE DB MODULE — the twin of the line below
    // it, and the piece that was missing. `session.setMode('real')` has always
    // put the SESSION back to what a launched process holds; the WORKSPACE
    // pointer was left wherever the ending session had moved it, so after any
    // duress session the pre-verdict door resolved the decoy for the whole of
    // the next locked window and every lock-screen answer in it died as
    // `failed_media`. No unlock arm runs in that window — a CallKit answer does
    // not unlock the phone — so `beginUnlock` cannot reach it and only this
    // can. See `relockWorkspace` for why it is here, after the close, and not
    // at the top of this function with the push gate.
    db.relockWorkspace();
    session.setMode('real');
    // The update answer belongs to the session that asked for it, and this
    // one is over. It is a process singleton, so without this line a real
    // session's 'soft' verdict stood in memory through the lock and the
    // decoy chat list rendered the real session's "Update available" card
    // from it. The getters refuse a non-real session as well; this is the
    // half that also covers a real unlock inheriting a stale answer.
    updateGate.forgetSession();
    setProfile(null);
    setRoute({ name: 'locked' });
  }, []);

  /** A status read has no safe fallback. Relock immediately, then — when an
   * opening was already inside an uncancellable dependency — wait for that
   * invalidated task and relock once more so a late transport start cannot be
   * the final state. Concurrent failures share the same teardown. */
  const failClosedAfterStatusRejection = useCallback((): Promise<void> => {
    const existing = failClosedRelock.current;
    if (existing) return existing;

    const opening = activeOpening.current?.task ?? null;
    const task = (async () => {
      await relock();
      if (opening) {
        await opening.catch(() => undefined);
        await relock();
      }
    })();
    failClosedRelock.current = task;
    const clear = () => {
      if (failClosedRelock.current === task) failClosedRelock.current = null;
    };
    void task.then(clear, clear);
    return task;
  }, [relock]);

  /** One generation and one tracked task cover cold boot, real unlock, and
   * duress unlock. The generation is reserved before boot's status read, so a
   * late boot answer cannot start opening after a foreground failure. */
  const beginWorkspaceOpening = useCallback(
    (kind: 'boot' | 'real' | 'duress') => {
      if (activeOpening.current || failClosedRelock.current) return;
      const generation = ++openingGeneration.current;
      const task = (async () => {
        let outcome: void | 'lock-status-rejected';
        if (kind === 'boot') {
          let status: lock.LockStatus;
          try {
            // Keychain only: no workspace byte is touched before this verdict.
            status = await lock.status();
          } catch {
            await relock();
            return;
          }
          if (!openingIsCurrent(generation)) return;
          if (isFirstRunAfterInstall()) {
            // Provider keys, like lock keys, can outlive an iOS uninstall.
            // Run regardless of lock status and before the install marker.
            // A refused deletion must not invent a lock with no passcode.
            // Owner-bound residue cannot configure for a different account;
            // mark this install so a later boot never wipes a newly saved key.
            await clearWritingConnections();
            // Uninstall normally removes the protocol files, while Keychain
            // preferences/bearer may survive. That bearer cannot recover the
            // lost private key and must never register push for the old ID.
            let identityPresent: boolean;
            try { identityPresent = await clearStaleInstallationCredentials(); }
            catch { await relock(); return; }
            // A retained App Group can still hold identity and plaintext
            // inbox data. A fresh defaults marker alone must not unlock it.
            if (status.enabled && !identityPresent) await lock.clearAll();
            if (!openingIsCurrent(generation)) return;
            if (!identityPresent) status.enabled = false;
          }
          markInstalled();
          if (status.enabled) {
            if (openingIsCurrent(generation)) setRoute({ name: 'locked' });
            return;
          }
          outcome = await enterRealWorkspace(generation);
        } else {
          outcome = await (kind === 'real'
            ? enterRealWorkspace(generation)
            : enterDecoyWorkspace(generation));
        }
        if (outcome === 'lock-status-rejected') await relock();
      })();
      const opening = { generation, task };
      activeOpening.current = opening;
      const clear = () => {
        if (activeOpening.current?.generation === generation) {
          activeOpening.current = null;
        }
      };
      void task.then(clear, clear);
    },
    [
      enterDecoyWorkspace,
      enterRealWorkspace,
      openingIsCurrent,
      relock,
    ],
  );

  useEffect(() => {
    beginWorkspaceOpening('boot');
  }, [beginWorkspaceOpening]);

  /** One verdict → one coordinator-owned workspace opening, single-flight. */
  const applyVerdict = useCallback(
    (verdict: 'real' | 'duress') => beginWorkspaceOpening(verdict),
    [beginWorkspaceOpening],
  );

  /**
   * The account is gone.
   *
   * Re-auth is silent by design — that is the whole feature — but there is one
   * answer it must NOT be silent about: 403 `identity_tombstoned` or 409
   * `account_conflict`, i.e. the signature verified and there is still no
   * account behind it. Left unsaid, the app shows "Offline" over a phone that
   * is signed in as nobody and will never come back, which is the same silent
   * death this work exists to end — only slower, because now it also stopped
   * retrying. The latch is terminal, so this state only ever arrives once.
   */
  const [gone, setGone] = useState(accountGone);
  useEffect(() => onAccountGone(() => {
    const isGone = accountGone();
    if (isGone) {
      writingWorkspaceReady.current = false;
      invalidateWritingSession();
    }
    setGone(isGone);
  }), []);

  const finishDeletionFromCover = async (fresh: boolean) => {
    if (deletionActionRunning.current || session.mode !== 'real' ||
        routeRef.current.name === 'locked' || routeRef.current.name === 'loading') return;
    deletionActionRunning.current = true;
    setDeletionBusy(true);
    const generation = openingGeneration.current;
    try {
      adoptPushRegistration({ real: false });
      if (fresh) await clearGoneAccount();
      else await deleteAccount();
      if (!openingIsCurrent(generation)) return;
      setRecoveryIntent(false);
      setProfile(null);
      setDeletionPending(false);
      setIdentityMissing(false);
      writingWorkspaceReady.current = true;
      setFreshStartConfirm(false);
      setRoute({ name: 'landing' });
    } catch {
      if (openingIsCurrent(generation)) setDeletionPending(true);
    } finally {
      deletionActionRunning.current = false;
      setDeletionBusy(false);
    }
  };

  // Screen security: blank every surface while the screen is captured, and
  // disclose a screenshot to the conversation it was taken in (the route is
  // the one place that knows which conversation is on screen).
  const [shouldBlank, setShouldBlank] = useState(screenSecurity.shouldBlank);
  useEffect(() => {
    const unsubscribe = screenSecurity.subscribe(() =>
      setShouldBlank(screenSecurity.shouldBlank),
    );
    void screenSecurity.init();
    return unsubscribe;
  }, []);
  const blankedBefore = useRef(false);
  useEffect(() => {
    if (shouldBlank) {
      // The iOS keyboard is its own system window ABOVE the app: a recording
      // would keep capturing key-pops and QuickType echoes of the message
      // being typed unless the keyboard goes away with the content.
      Keyboard.dismiss();
      AccessibilityInfo.announceForAccessibilityWithOptions(COPY_COVER.line, {
        queue: true,
      });
      blankedBefore.current = true;
    } else if (blankedBefore.current) {
      AccessibilityInfo.announceForAccessibilityWithOptions(COPY_COVER.over, {
        queue: true,
      });
    }
  }, [shouldBlank]);
  // Whether the capture cover renders is the visible-surface model's fact
  // (`surfaceFacts.captureCoverApplies`): the lock screen alone stays
  // visible during a capture — a person must be able to unlock (or
  // duress-unlock) while mirroring, there is nothing to read on it, and the
  // pad never echoes digits; landing/loading are empty too — but a live
  // call overlay over ANY route is covered (the design as amended: locked,
  // landing and loading alike — the overlay, not the route, is on glass).
  useEffect(() => {
    return screenSecurity.onScreenshot(() => {
      // Disclose only what was actually disclosed: behind the capture cover
      // or the app-switcher overlay the screenshot contains no conversation,
      // and a notice would manufacture false evidence (and leak presence).
      // Same away-state reading as appActive above: 'unknown' counts as on.
      const appState = AppState.currentState;
      if (
        screenSecurity.shouldBlank ||
        appState === 'background' ||
        appState === 'inactive'
      ) {
        return;
      }
      // The visible-surface model owns "which conversation is on screen"
      // thread/photoViewer disclose to their peer, nothing else — and
      // a call overlay adds no disclosure target (the design leaves this path
      // alone).
      for (const peerId of surfaceFactsRef.current.screenshotDisclosureTo) {
        // Best-effort by contract: sendScreenshotNotice never throws.
        void messaging.sendScreenshotNotice(peerId);
      }
    });
  }, []);

  // CHECK POINT 3: the app coming back to the foreground, throttled
  // to once per six hours inside the gate. Its OWN listener, deliberately
  // apart from the lock/transport one below: that branch is a chain of
  // fail-closed early returns owned by the relock verdict, and a policy
  // fetch has no business inside it.
  //
  // Only from a surface that PROVES a workspace is open — the same
  // visible-surface fact the preview-lease renewal reads. `session.mode`
  // defaults to 'real' at launch, so "not duress" alone would also match
  // the lock screen and the landing screen, and a phone that foregrounds
  // into the lock screen must stay network-silent.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => {
      if (next !== 'active') return;
      if (session.mode !== 'real') return;
      if (!surfaceFactsRef.current.provesWorkspaceOpen) return;
      void (async () => {
        const generation = openingGeneration.current;
        const gate = await checkForUpdate('foreground');
        if (gate !== 'blocked') return;
        // EVERY PRECONDITION IS RE-READ AFTER THE AWAIT, NOT JUST THE
        // SURFACE. The three guards above this task ran before a fetch that
        // can take seconds, and all three can go stale in that window.
        //
        // The generation covers a relock and any other opening: an answer
        // that belongs to the session that asked must not navigate for the
        // one that replaced it. The session mode is checked again because
        // it is the one that matters most and the generation is not
        // literally it: a DURESS session that began while this was in
        // flight would otherwise be shown the wall, and the wall's only
        // control opens the REAL workspace. A decoy that ever showed this
        // screen would also be telling a coercer which phone this is.
        if (openingGeneration.current !== generation) return;
        if (session.mode !== 'real') return;
        if (!surfaceFactsRef.current.provesWorkspaceOpen) return;
        // The wall says this build can no longer connect; this is what makes
        // that sentence true on this path as well.
        await quiesceForUpdateWall();
        if (openingGeneration.current !== generation) return;
        if (session.mode !== 'real') return;
        setUpdateRecheck('idle');
        setRoute({ name: 'updateRequired' });
      })();
    });
    return () => subscription.remove();
  }, [checkForUpdate, quiesceForUpdateWall]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => {
      const writingEpoch = ++writingForegroundEpoch.current;
      setWritingForeground(false);
      setAppActive(next === 'active');
      if (next === 'background') {
        backgroundedAt.current = Date.now();
        // The one moment the badge is actually looked at. The server's count
        // is a stand-in for the window where the app is not running; from here
        // on this device's own unread total is the better answer, so it
        // overwrites it on the way out.
        void syncBadge();
        // The preview lease is renewed HERE and not on foregrounding: the
        // foreground path immediately decides whether to relock, relock's
        // disarm is async, and a fire-and-forget renewal issued just before it
        // could land just after and re-arm a locked app. Backgrounding cannot
        // race anything — the session leaving the screen is the session the
        // lease describes. Never from duress, whose previews are disarmed.
        // Renewed only from a surface that PROVES a workspace is open —
        // chats, a thread, settings (the visible-surface model's fact).
        // `session.mode` defaults to 'real' at launch, so "not locked" alone
        // also matched loading/landing/register: a locked launch backgrounded
        // before `lock.status()` resolved could extend a crash-stale lease by
        // seven days without any unlock having happened. A call overlay
        // proves nothing here — it starts before the verdict by design.
        if (
          session.mode === 'real' &&
          surfaceFactsRef.current.provesWorkspaceOpen
        ) {
          void renewPreviews();
        }
        // CLOSE THE SOCKET, unless a call holds the process awake. iOS
        // freezes a backgrounded app but leaves its TCP connection standing,
        // so a socket left open makes the server deliver every message into a
        // frozen buffer, mark it delivered, and push NOTHING — a messenger
        // whose notifications only work ten minutes after backgrounding, once
        // the idle timeout finally kills what this line kills now. During a
        // call the process is NOT frozen (voip background mode) and the
        // socket is the call's signalling path; pausing it would drop ICE
        // restarts and hangup frames mid-call.
        //
        // EITHER SHAPE OF CALL. `callRef` mirrors the 1:1 machine only; a
        // live small-group session is N legs on the same socket, and pausing
        // under it stopped every ICE restart, hangup, `gleave` and `call.end`
        // until the 30 s reconnect window expired as `failed_media`. The
        // coordinator's own view is read rather than mirrored: it is a
        // module-level fact, current at the moment this listener runs.
        if (callRef.current.name === 'idle' && groupCall().view === null) {
          messaging.pause();
        }
      } else if (next === 'active') {
        // And on the way back in: a notification that arrived while the app
        // was foreground still raised the icon, and nothing else clears it.
        void syncBadge();
        // Consume the timestamp FIRST: an early return below must not leave
        // it armed to trigger a spurious instant relock much later.
        const away =
          backgroundedAt.current == null
            ? null
            : Date.now() - backgroundedAt.current;
        backgroundedAt.current = null;
        void (async () => {
          const checkedGeneration = openingGeneration.current;
          // FAIL CLOSED. The status read is the verdict this whole branch
          // turns on, and "could not read the lock" must never resume a
          // workspace an elapsed autolock may be owed. An earlier revision
          // caught a rejection into {enabled: false} so a Keychain hiccup
          // could not strand the app paused — which was precisely a
          // secret-storage error bypassing the lock (a Keychain error must
          // not unlock on iOS either). Now a rejection RELOCKS: the
          // workspace closes, the transport stays down, and the cost is one
          // lock-screen tap once the Keychain answers again — the lock
          // screen's own verify re-reads it. Handled, not thrown, so the
          // task still runs to a decision instead of aborting mid-branch.
          let status: lock.LockStatus;
          try {
            status = await lock.status();
          } catch {
            await failClosedAfterStatusRejection();
            return;
          }
          // A relock or a new opening won while the Keychain read was in
          // flight. This answer belongs to the old generation and may neither
          // resume its transport nor navigate for it.
          if (openingGeneration.current !== checkedGeneration) return;
          const current = routeRef.current.name;
          // FAIL CLOSED on the clock: `away` is wall-clock arithmetic, and
          // a clock moved backwards while backgrounded makes it negative —
          // which must relock, never resume. `away == null` stays a resume
          // on purpose: it is null exactly on an inactive→active edge with
          // no background edge recorded (control centre, the Face ID
          // prompt, an incoming-call banner), and relocking there would
          // lock the app on every such edge under the default "Right away"
          // autolock.
          const mustRelock =
            status.enabled &&
            current !== 'locked' &&
            current !== 'loading' &&
            away != null &&
            (away < 0 || away >= status.autolockSec * 1000);
          if (mustRelock) {
            await relock();
            return;
          }
          // An inactive/active cycle during the secure read retires this
          // verdict. Only the latest foreground edge may reopen AI access.
          if (writingForegroundEpoch.current === writingEpoch &&
            AppState.currentState === 'active') setWritingForeground(true);
          // Not relocking: reopen the socket the background pause closed.
          // After the relock decision on purpose — resuming first would dial
          // a connection the relock tears down a beat later — and never for a
          // duress session, which is network-silent. resume() itself no-ops
          // when messaging was never started, so landing/register/locked
          // routes cost nothing here.
          if (session.mode === 'real' && current !== 'locked' && current !== 'loading') {
            resumeCallMetricDrainAfterTransportResume();
            // And re-offer the push registration a couple of tries: the
            // first device run showed a launch whose uploads all died on a
            // flapping network, with nothing retrying until the next launch.
            // Idempotent server-side, and the merge rule means a success
            // can only ever add tokens, never lose one.
            nudgePushRegistration();
            // The warm tap: a notification tapped
            // while the app was merely backgrounded — no relock due —
            // redeems on this same foreground edge, under the same
            // real-session gate as the resume, and only from a surface the
            // visible-surface model says a tap may be consumed on:
            // landing and register have no workspace for a thread to live
            // in. The relock branch returned before this line, so a tap
            // that must cross the lock waits for the unlock arm's own
            // redemption instead.
            if (surfaceFactsRef.current.pushNavRedeemable) {
              const navigationGeneration = openingGeneration.current;
              void consumePendingNav().then(peerId => {
                // And it may only LAND on a surface that is not the lock
                // screen (the model's second push-nav fact): a redemption
                // resolving after a relock must wait for the unlock arm.
                if (
                  peerId &&
                  openingGeneration.current === navigationGeneration &&
                  surfaceFactsRef.current.pushNavLandable
                ) {
                  setRoute({ name: 'thread', peerId });
                }
              });
            }
          }
        })();
      }
    });
    return () => subscription.remove();
  }, [failClosedAfterStatusRejection, relock]);

  useEffect(() => {
    // Dev-only: lets scripts/app-verify.sh drive navigation (the same
    // setRoute the screens call). Never attached outside __DEV__.
    if (__DEV__) {
      const dev = globalThis as unknown as Record<string, unknown>;
      dev.TacendumDevNav = (r: Route) => setRoute(r);
      dev.TacendumDevOpenAttention = () => setRoute({ name: 'attention' });
      dev.TacendumDevOpenApproval = (peerId: string, q: string) =>
        setRoute({
          name: 'thread',
          peerId,
          from: 'attention',
          focusedApprovalQ: q,
        });
      // The scripted lock checks need the same unlock path the LockScreen
      // uses (verify → single-flight verdict), minus the pad UI (jest covers
      // the pad).
      dev.TacendumDevUnlock = async (code: string) => {
        const result = await lock.verify(code);
        if (result.verdict === 'real' || result.verdict === 'duress') {
          applyVerdict(result.verdict);
        }
        return result.verdict;
      };
    }
  }, [applyVerdict]);

  useEffect(() => {
    // Dev-only route probe for scripts/app-verify.sh.
    if (__DEV__) {
      (globalThis as unknown as Record<string, unknown>).TacendumDevRoute =
        route.name;
    }
  }, [route]);

  // The link-offer hop's ONE-SHOT LATCH: armed at boot (a durable
  // link_pending_offer row may predate this process) and by every landing
  // notice; spent by the hop that serves it, or by a probe that finds
  // nothing waiting. Spent — never re-armed by a home arrival on its own —
  // because the confirm surface's chevron and its Close controls leave the
  // row in place (only accept/decline consume it), and a re-read on the way
  // back to chats would re-open the surface until the offer expired: a
  // ten-minute trap.
  const offerHopOwed = useRef(true);

  useEffect(() => {
    // A pending link offer landed: surface
    // the confirm screen — but only over a HOME surface. Mid-thread,
    // mid-call, or pre-verdict, the offer stays durably stored
    // (link_pending_offer) and the person reaches it the next time a home
    // surface is on glass (the effect below); navigation is never stolen
    // from under a hand.
    return onPendingOffer(() => {
      offerHopOwed.current = true;
      const name = routeRef.current.name;
      if (name === 'chats' || name === 'calls') {
        offerHopOwed.current = false;
        // The home surface it arrived over is the one Back returns to.
        setRoute({ name: 'linkConfirm', from: name });
      }
    });
  }, []);

  useEffect(() => {
    // A pending link offer that landed OFF a home surface: the notice-time
    // hop above fires only when chats/calls is on glass at that instant;
    // otherwise the durable link_pending_offer row sat unread until its ten
    // minutes ran out. Re-read it when a home surface next comes on glass —
    // an offer that arrived mid-thread, in Settings or on Profile is shown
    // at the next natural moment. Through the PROBE (no fetch, no pin, no
    // signature check; dead rows reaped), so the hop never lands on "there
    // is no link request waiting". Real session only: a duress session never
    // links.
    if (route.name !== 'chats' && route.name !== 'calls') return;
    if (session.mode !== 'real' || !profile) return;
    if (!offerHopOwed.current) return;
    let stale = false;
    void pendingOfferWaiting()
      .then(waiting => {
        if (stale) return;
        if (!waiting) {
          offerHopOwed.current = false;
          return;
        }
        const name = routeRef.current.name;
        if (name !== 'chats' && name !== 'calls') return;
        offerHopOwed.current = false;
        // Same rule as the notice-time hop: back to the home it landed on.
        setRoute({ name: 'linkConfirm', from: name });
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [route.name, profile]);

  useEffect(() => {
    // A recovery was REQUESTED against this account's grouping: the cancel — which WINS at any moment
    // inside the 72 h delay — lives on the linked-devices surface. The
    // surface opens ITSELF when the requested notice lands, exactly the
    // pending-link-offer precedent above: only over a HOME surface, never
    // stealing navigation from a thread or a call. Kept now that the
    // Settings entry has landed — a cancel this urgent
    // must not wait for a visit to Settings. Cancelled/completed notices
    // navigate nowhere — they are settled loudness, rendered where the
    // person next looks.
    return onRecoveryNotice(() => {
      const name = routeRef.current.name;
      if (name !== 'chats' && name !== 'calls') return;
      void db
        .loadRecoveryNotice()
        .then(notice => {
          if (
            notice?.kind === 'requested' &&
            profileRef.current &&
            (routeRef.current.name === 'chats' || routeRef.current.name === 'calls')
          ) {
            // UNMARKED on purpose: this roster opened ITSELF over a home
            // surface, so there is no Settings visit behind it to return
            // to. Back goes where it always did — Settings, then Profile.
            setRoute({ name: 'linkedDevices' });
          }
        })
        .catch(() => undefined);
    });
  }, []);

  const refreshProfile = useCallback(() => {
    void db
      .loadProfile()
      .then(p => {
        // loadProfile builds a fresh object every call, so setting it
        // unconditionally gives the router a new profile identity on every
        // receipt and re-renders every screen. A card is written maybe once a
        // week: compare the row and stay quiet when nothing moved.
        if (!p) return;
        const current = profileRef.current;
        if (current && sameProfile(current, p)) return;
        setProfile(p);
      })
      .catch(() => undefined); // db closed behind the lock screen — ignore
  }, []);

  /** Pop to wherever the current surface's own Back control goes, so the edge
   * swipe can never disagree with the chevron. Reports whether it navigated:
   * an autolock can land between the touch and the release, and a swipe that
   * resolves to nothing must not leave the surface dragged off-screen. */
  const goBack = useCallback((fromSwipe = false) => {
    // A full-screen live call answers Back by MINIMIZING: the
    // call keeps going, the small window appears, and the
    // route underneath — which a call never changed — is what the person
    // returns to. Consumed (true), so Android's system back never pops the
    // INVISIBLE route behind the call, which is what it did before. Only
    // where the window may exist at all (a workspace route, a real session)
    // and only for the states the window can show; otherwise Back means
    // what it always meant here.
    const live = callRef.current;
    const overlayAllowed = callOverlayAllowed(routeRef.current.name);
    if (
      (live.name === 'connected' || live.name === 'reconnecting') &&
      live.call !== null &&
      !callMinimizedRef.current &&
      overlayAllowed
    ) {
      setCallMinimized(true);
      return true;
    }
    // AND WHERE THERE IS NOTHING TO MINIMIZE TO, BACK STILL STOPS HERE
    // . The minimize above covered two
    // states of the 1:1 machine; a group session, a call still ringing out,
    // and an incoming ring all put a full-screen surface on glass with no
    // window to put it in, and all three fell through to `backDestination`
    // and popped the route the call was covering. Consumed, changing
    // nothing: hanging up is how a call ends.
    if (
      callSurfaceOwnsGlass({
        call: live,
        callMinimized: callMinimizedRef.current,
        overlayAllowed,
        groupCallLive: groupCall().view !== null,
      })
    ) {
      return true;
    }
    if (fromSwipe && routeRef.current.name === 'settings' &&
        settingsBackHandlerRef.current?.()) {
      // Settings consumed the gesture locally (or blocked it during a write).
      // Its route key is unchanged, so reset the drag instead of leaving
      // the still-mounted page translated off-screen.
      return false;
    }
    const destination = backDestination(routeRef.current);
    if (!destination) return false;
    setRoute(destination);
    return true;
  }, []);

  /**
   * A screen's own Back chevron, popped through the ONE table.
   *
   * The table's docstring already says every case mirrors the visible
   * control on that screen — but nothing enforced it, and two props
   * restated a destination in their own words until the words drifted. A
   * chevron takes the route it is rendering and asks the table; a root
   * (which no chevron renders on) is left alone rather than navigated to
   * nowhere. Deliberately NOT `goBack`: this is a press on a control the
   * person can see, so it never means "minimize the call".
   */
  const popRoute = useCallback((from: Route) => {
    const destination = backDestination(from);
    if (destination) setRoute(destination);
  }, []);

  useEffect(() => {
    // ANDROID SYSTEM BACK: the hand-rolled router
    // keeps no stack, so the hardware back must pop through the same
    // `backDestination` the chevron and the edge swipe use — `goBack` already
    // reports whether it navigated. True consumes the press; false at a root
    // hands it to the system, which backgrounds the app (the platform's own
    // contract — anything else traps the person in the app). Without this
    // handler the system back backgrounded the app from EVERY screen.
    // `back.android.test.ts` pins both branches. (Predictive back is
    // deferred.)
    if (Platform.OS !== 'android') return;
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => goBack(),
    );
    return () => subscription.remove();
  }, [goBack]);

  // Async screen callbacks belong to the opening that rendered them. A
  // deletion finishing after relock must not route around the new cover.
  const surfaceOpeningGeneration = openingGeneration.current;
  const surfaceSessionMode = session.mode;

  // The two home LIST surfaces, built once and rendered by whichever
  // projection owns them this render: compact mounts them as the chats/calls
  // routes; wide mounts them in the list pane beside an open detail. One
  // element, one set of props — the pane's list cannot drift from the
  // phone's.
  const chatListSurface =
    profile &&
    (namingStep ? (
      // The naming moment stands where the list will: the same slot
      // in both projections, so a wide window asks in the list pane.
      <NamingScreen
        profile={profile}
        onDone={saved => {
          if (saved) setProfile(saved);
          setNamingPending(false);
        }}
      />
    ) : (
      <ChatListScreen
        profile={profile}
        selectedPeerId={selectedPeerId}
        onOpenChat={peerId => setRoute({ name: 'thread', peerId })}
        onOpenProfile={() => setRoute({ name: 'profile', from: 'chats' })}
        onStartChat={() => setRoute({ name: 'newChat' })}
        onStartRoom={() => setRoute({ name: 'newRoom' })}
        // The App Lock nudge's "Open Settings": the lock
        // lives on the Settings surface, so that is where the door goes —
        // and `from` is what brings the person back HERE afterwards.
        onOpenAppLock={() => setRoute({ name: 'settings', from: 'chats', section: 'privacy' })}
        // The Field Mode line under the title, and the seventh
        // push site. A setting somebody turned on before walking somewhere
        // and then cannot find is a setting they are carrying blind, so the
        // line that names it is also the way back to it. Same destination
        // and same `from` as the nudge above — one screen, two doors, one
        // way out — and the line renders its words either way: absent this
        // prop the screen deliberately offers no control, which is the
        // LockNudge's rule that nothing may promise a route it was not given.
        onOpenSettings={() => setRoute({ name: 'settings', from: 'chats' })}
        onOpenAttention={() => setRoute({ name: 'attention' })}
      />
    ));
  const callsSurface = profile && (
    <CallsScreen
      // The shared home header's profile door: the same disc, in the same
      // corner, as the Chats tab above — the screen renders it only when
      // BOTH are given, and nothing gave them.
      profile={profile}
      onOpenProfile={() => setRoute({ name: 'profile', from: 'calls' })}
      onOpenChat={peerId => setRoute({ name: 'thread', peerId, from: 'calls' })}
      // THE REASON IS RESOLVED, NOT DISCARDED. Permission is
      // still asked at the moment of the call and a denied camera still
      // downgrades to audio — but a denied MICROPHONE, a blocked peer or a
      // changed safety number used to end here in `return;` and an empty
      // catch, which is what made every row's redial a dead button: no
      // ring, no error, no screen. The screen holds the sentence and
      // renders it under its header.
      onCall={async (peerId, kind) => {
        try {
          const permission = await ensurePermissions(kind === 'video');
          if (!permission.ok) return permission.reason ?? null;
          await callController().placeCall(peerId, await nextMsgId(), permission.video);
          return null;
        } catch (err) {
          // The CLASS is the contract; its `message` is written for a log
          // ('peer is blocked') and is never what a person reads.
          if (err instanceof CallRefusedError) return CALL_REFUSAL_FOR[err.reason];
          return null;
        }
      }}
    />
  );

  // The routed surface, one switch shared by BOTH projections: compact
  // renders it as the whole window; wide renders it as the detail pane. The
  // blocks below are the original compact tree, byte for byte — extracting
  // them is what keeps the phone path provably unchanged while the wide
  // shell reuses it.
  const routeSurface = (
    <>
        {route.name === 'loading' && (
          <View style={styles.loading}>
            {/* This frame owns the whole of initDb + loadProfile +
                messaging.start on a cold launch. The launch storyboard is a
                bare paper field, so the mark ARRIVES here — solid bar, a
                beat, the reply — rather than blinking out and back. Never a
                spinner; Reduce Motion renders it settled. The wrapper gives
                VoiceOver the name the mark only shapes. */}
            <View
              accessible
              accessibilityRole="header"
              accessibilityLabel="Tacendum"
            >
              <BrandMark size={20} animate />
            </View>
          </View>
        )}

        {route.name === 'locked' && <LockScreen onUnlocked={applyVerdict} />}

        {route.name === 'updateRequired' && (
          <UpdateRequiredScreen
            url={storeUrl(updatePolicy)}
            message={updatePolicy?.message}
            checking={updateRecheck === 'checking'}
            stillOld={updateRecheck === 'stillOld'}
            // "Check again" is the ONLY way out, and it re-enters the same
            // opening the gate turned back: with the floor lowered (or the
            // row deleted) the app opens exactly as it would have, and with
            // no profile it lands on the landing screen. Nothing here
            // pretends a workspace is already open.
            onCheckAgain={() => {
              if (updateRecheck === 'checking') return;
              // THE WALL IS A REAL-SESSION SURFACE, AND THIS LINE IS WHAT
              // MAKES THAT SAFE RATHER THAN MERELY INTENDED. `checkNow`
              // short-circuits to 'ok' in duress, so in a decoy session
              // `gate !== 'blocked'` is guaranteed and the branch below
              // would run `beginWorkspaceOpening('real')`: one tap under
              // coercion turning the decoy world into the real one, from
              // the only control on the screen. The check point above no
              // longer raises the wall over a decoy at all; this refuses
              // the conversion even if some later path does.
              if (session.mode !== 'real') return;
              const generation = openingGeneration.current;
              setUpdateRecheck('checking');
              void (async () => {
                const gate = await checkForUpdate('recheck');
                setUpdateRecheck(gate === 'blocked' ? 'stillOld' : 'idle');
                if (gate === 'blocked') return;
                // A relock (or any other opening) won while this was in
                // flight. Opening from here would dismiss whatever screen
                // that put up, the lock screen included.
                if (openingGeneration.current !== generation) return;
                if (session.mode !== 'real') return;
                if (routeRef.current.name !== 'updateRequired') return;
                beginWorkspaceOpening('real');
              })();
            }}
          />
        )}

        {route.name === 'landing' && (
          <LandingScreen
            // CHECK POINT 1: before registration BEGINS, not after.
            // A build the server will not talk to must not create an
            // account it cannot then use — and this is the one check point
            // that runs with no profile on the phone at all. The route
            // still changes on a failed check: unknown allows.
            //
            // AND IT NAVIGATES ONLY IF THE SCREEN IT WAS PRESSED ON IS
            // STILL THERE. This continuation can resolve seconds later, and
            // a relock in that window leaves the app on the lock screen:
            // an unguarded `setRoute` then dismissed the lock without any
            // unlock, which is the fail-closed invariant the foreground
            // branch pins for itself a few hundred lines up. The generation
            // is the same fence that branch uses; the route check catches
            // the ordinary case of someone navigating away meanwhile.
            // A check in flight, said on the button itself. The busy state is
            // cleared in a `finally` rather than on the navigating arm: every
            // early return above is a case where this screen STAYS, and a flag
            // left set there is a permanently dead door.
            checkingUpdate={checkingUpdate}
            onGetStarted={() => {
              const generation = openingGeneration.current;
              setCheckingUpdate(true);
              void (async () => {
                try {
                  const gate = await checkForUpdate('getStarted');
                  if (openingGeneration.current !== generation) return;
                  if (routeRef.current.name !== 'landing') return;
                  if (gate === 'blocked') setUpdateRecheck('idle');
                  setRoute(
                    gate === 'blocked'
                      ? { name: 'updateRequired' }
                      : { name: 'register' },
                  );
                } finally {
                  setCheckingUpdate(false);
                }
              })();
            }}
            // Recovery has its own entry and screen so registration
            // stays identifier-free, structurally.
            onRecover={() => setRoute({ name: 'recover', from: 'landing' })}
          />
        )}

        {route.name === 'register' && (
          <RegisterScreen
            onBack={() => setRoute({ name: 'landing' })}
            onRegistered={p => {
              if (!openingIsCurrent(surfaceOpeningGeneration) ||
                  session.mode !== surfaceSessionMode || routeRef.current.name !== 'register') return;
              // Registration is an explicit account-opening event. Background
              // access remains independently denied until its lock verdict.
              if (writingWorkspaceReady.current && session.mode === 'real' &&
                routeRef.current.name === 'register') setWritingAccess(p.userId);
              setProfile(p);
              // Arm the naming moment: the chat list asks "What should
              // people call you?" before it shows anything else.
              setNamingPending(true);
              // The auth token exists only now. `startCalling` already tried
              // to register this device's push tokens and gave up because
              // there was nothing to authenticate with — and it runs once per
              // process, on a component that never remounts, so nothing would
              // ever try again. Without this line a freshly created account
              // receives no notifications until the app is force-quit and
              // relaunched.
              adoptPushRegistration({ real: true });
              void (async () => {
                // WHO THIS DEVICE IS, told to the call module the same way the
                // push registration above and `messaging.start` are told. It
                // read the profile once, inside `startCalling`, which on this
                // launch ran before any account existed — so without this line
                // small-group calls stay `not_registered` for the whole
                // process: no outbound session, and every inbound ginvite
                // dropped before admission or dismissal.
                //
                // AWAITED, AND BEFORE THE SOCKET, for the reason the unlock
                // path states: `void` here let the socket start delivering
                // while `selfAccountId` was still null, and a ginvite arriving
                // in that window is dropped silently at `if (!selfId)`.
                await refreshSelfAccountId();
                // finally, not then: the profile is already on disk and the
                // chat list reports Offline honestly, so a rejected start (no
                // Keychain token, an unreadable Keychain) must still navigate.
                // Leaving the person on the create screen invites a second
                // tap, and the account already exists by the time we are here.
                await messaging
                  .start(p.userId)
                  .then(() => activateCallMetricDrainForWorkspace())
                  // A registration entered THROUGH the recovery door: return there — the identity is
                  // made, and the email step was deliberately never part
                  // of registration itself.
                  .finally(() =>
                    setRoute(
                      recoveryIntent()
                        ? { name: 'recover', from: 'chats' }
                        : { name: 'chats' },
                    ),
                  );
              })().catch(() => undefined);
            }}
          />
        )}

        {route.name === 'chats' && chatListSurface}

        {route.name === 'calls' && callsSurface}

        {route.name === 'attention' && (
          <AttentionScreen
            onBack={() => setRoute({ name: 'chats' })}
            onOpenApproval={(peerId, q) =>
              setRoute({
                name: 'thread',
                peerId,
                from: 'attention',
                focusedApprovalQ: q,
              })
            }
            onOpenConversation={peerId =>
              setRoute({ name: 'thread', peerId, from: 'attention' })
            }
          />
        )}


        {route.name === 'newChat' && profile && (
          <StartChatScreen
            profile={profile}
            onBack={() => setRoute({ name: 'chats' })}
            onOpenChat={peerId => setRoute({ name: 'thread', peerId })}
            onFindByEmail={() => setRoute({ name: 'discover' })}
          />
        )}

        {/* Find by email: the typed-single-
            identifier flow, under Start a chat. The result card opens the
            ordinary thread — TOFU unchanged. */}
        {route.name === 'discover' && profile && (
          <DiscoveryScreen
            onOpenAccountEmail={() => setRoute({ name: 'accountEmail', from: 'chats' })}
            onBack={() => setRoute({ name: 'newChat' })}
            onOpenChat={chatId => setRoute({ name: 'thread', peerId: chatId })}
          />
        )}

        {route.name === 'newRoom' && profile && (
          <GroupCreateScreen
            profile={profile}
            onBack={() => setRoute({ name: 'chats' })}
            // A room's conversation is a chats row whose peerId is the room
            // ULID, so the thread route carries it as any
            // peerId.
            onOpenRoom={groupId => setRoute({ name: 'thread', peerId: groupId })}
          />
        )}

        {route.name === 'thread' && profile && (
          <ChatThreadScreen
            // A different conversation is a different INSTANCE. Un-keyed, a
            // thread→thread route change — the wide shell's list pane, a
            // foreground push redemption — reused the mounted screen with a
            // new peerId, and its composer state (draft, reply chip, failed
            // photo) crossed over with it.
            key={`${route.peerId}:${route.focusedApprovalQ ?? ''}`}
            peerId={route.peerId}
            focusedApprovalQ={route.focusedApprovalQ}
            onBack={() => popRoute(route)}
            onOpenPeerProfile={() =>
              setRoute({
                name: 'peerProfile',
                peerId: route.peerId,
                from: route.from,
              })
            }
            onOpenGroupProfile={() =>
              setRoute({
                name: 'groupProfile',
                groupId: route.peerId,
                from: route.from,
              })
            }
            onOpenPhoto={(msgId, direction) =>
              setRoute({
                name: 'photoViewer',
                peerId: route.peerId,
                msgId,
                direction,
                from: route.from,
              })
            }
            onStartCall={kind => {
              const peerId = route.peerId;
              void (async () => {
                // Asked at the moment of the call, never at launch. A
                // denied camera downgrades to audio rather than refusing —
                // an audio call is still a call.
                const permission = await ensurePermissions(kind === 'video');
                if (!permission.ok) return;
                await callController().placeCall(peerId, await nextMsgId(), permission.video);
              })().catch(() => {
                // Same refusal contract as the Calls tab above.
              });
            }}
            // The room's small-group call. The roster
            // comes from the thread's own fold and the SESSION comes from
            // `startGroupCall` — the cap, the ordering, the invites and the
            // refusals are all its, and nothing here re-decides any of them.
            onStartRoomCall={(others, kind) => {
              const roomId = route.peerId;
              void (async () => {
                const permission = await ensurePermissions(kind === 'video');
                if (!permission.ok) return;
                await startGroupCall([...others], permission.video, roomId);
              })().catch(() => {
                // Refusals (duress, busy, blocked, an unregistered device)
                // are the coordinator's to raise; the screen it would have
                // opened simply does not open.
              });
            }}
          />
        )}

        {route.name === 'profile' && profile && (
          <ProfileScreen
            profile={profile}
            // The chevron reads the SAME table the edge swipe and Android's
            // hardware back read: a hard-coded destination here is
            // how the three of them came to disagree.
            onBack={() => popRoute(route)}
            onProfileChanged={p => setProfile(p)}
            onOpenSettings={() => setRoute({ name: 'settings', from: 'profile' })}
            onSignedOut={() => {
              if (!openingIsCurrent(surfaceOpeningGeneration) ||
                  session.mode !== surfaceSessionMode || routeRef.current.name !== 'profile') return;
              invalidateWritingSession();
              setRecoveryIntent(false);
              setDeletionPending(false);
              setProfile(null);
              setRoute({ name: 'landing' });
            }}
            onDeletionPending={() => {
              if (!openingIsCurrent(surfaceOpeningGeneration) ||
                  session.mode !== surfaceSessionMode || routeRef.current.name !== 'profile') return;
              setDeletionPending(true);
            }}
          />
        )}

        {route.name === 'settings' && (
          <SettingsScreen
            backHandlerRef={settingsBackHandlerRef}
            initialSection={route.section}
            onSectionChange={section => setRoute(current =>
              current.name === 'settings'
                ? { ...current, section: section ?? undefined }
                : current,
            )}
            // Same table, same reason: Settings is reached from two doors.
            onBack={() => popRoute(route)}
            // Each row hands the sub-screen the origin THIS surface was
            // entered with, so the way out is the way in however deep it goes.
            onOpenLinkedDevices={() =>
              setRoute({ name: 'linkedDevices', from: route.from })
            }
            onOpenAccountEmail={() =>
              setRoute({ name: 'accountEmail', from: route.from })
            }
            onOpenAccountUsername={() =>
              setRoute({ name: 'accountUsername', from: route.from })
            }
            // LOCK NOW. The row is `relock()` and nothing else:
            // the same teardown a background auto-lock takes — the call
            // ended through its own terminal funnel, messaging stopped, the
            // db closed, the workspace pointer put back — so this door adds
            // no second state machine and no new native call, and a coerced
            // tap locks the decoy exactly as a real one locks the real
            // workspace. Voided rather than awaited because the row is a
            // verb, not a form: `relock` swallows what it can and ends at
            // `setRoute({ name: 'locked' })` regardless, and there is no
            // failure a person on the way out could act on.
            onLockNow={() => void relock()}
          />
        )}

        {/* Device linking. The routes, screens, and back mapping were
            already in place, so the Settings entry above is exactly the one
            line this comment always promised. linkConfirm additionally opens itself:
            a pending offer notice navigates from a home surface below. */}
        {route.name === 'linkedDevices' && profile && (
          <LinkedDevicesScreen
            profile={profile}
            onBack={() => popRoute(route)}
            onLinkNew={() => setRoute({ name: 'linkDevice', from: route.from })}
          />
        )}

        {route.name === 'linkDevice' && profile && (
          <LinkDeviceScreen
            profile={profile}
            onBack={() => popRoute(route)}
            onDone={() => setRoute({ name: 'linkedDevices', from: route.from })}
          />
        )}

        {route.name === 'linkConfirm' && profile && (
          <LinkConfirmScreen
            profile={profile}
            onClose={() => setRoute({ name: 'chats' })}
          />
        )}

        {/* The email + discoverability surface.
            Like linkedDevices, the route, screen, and back mapping were
            already in place; the Settings entry above is the
            promised one line. */}
        {route.name === 'accountEmail' && profile && (
          <AccountEmailScreen onBack={() => popRoute(route)} />
        )}

        {/* The phone + discoverability surface
            — the email screen's sibling, DARK behind PHONE_UI_ENABLED: the
            screen itself renders null while the pin is false, so even a
            programmatic route entry shows nothing in a dark build. */}
        {route.name === 'accountPhone' && profile && (
          <AccountPhoneScreen onBack={() => popRoute(route)} />
        )}

        {/* The username surface — the identifier
            siblings' sibling, DARK behind USERNAME_UI_ENABLED: the screen
            itself renders null while the pin is false, so even a
            programmatic route entry shows nothing in a dark build. */}
        {route.name === 'accountUsername' && profile && (
          <AccountUsernameScreen
            onBack={() => popRoute(route)}
            onOpenAccountEmail={() =>
              setRoute({ name: 'accountEmail', from: route.from, via: 'username' })
            }
          />
        )}

        {/* Recovery: reachable from Landing
            pre-registration (profile null — the screen explains and hands
            off to the ORDINARY register flow) and revisited after the
            registration it requested completes. */}
        {route.name === 'recover' && (
          <RecoveryScreen
            profile={profile}
            onBack={() =>
              setRoute(
                route.from === 'chats' && profile
                  ? { name: 'chats' }
                  : { name: 'landing' },
              )
            }
            onCreateIdentity={() => {
              setRecoveryIntent(true);
              setRoute({ name: 'register' });
            }}
            onDone={() => {
              setRecoveryIntent(false);
              setRoute({ name: 'chats' });
            }}
          />
        )}

        {route.name === 'peerProfile' && profile && (
          <PeerProfileScreen
            peerId={route.peerId}
            me={profile}
            // One source for the chevron, the swipe and hardware back: the
            // destination depends on where the profile was opened from,
            // and backDestination is where that is stated.
            onBack={() => {
              const destination = backDestination(route);
              if (destination) setRoute(destination);
            }}
          />
        )}

        {route.name === 'groupProfile' && profile && (
          <GroupProfileScreen
            groupId={route.groupId}
            me={profile}
            onBack={() =>
              setRoute({
                name: 'thread',
                peerId: route.groupId,
                from: route.from,
              })
            }
            // A member's safety number and block control live on their own
            // profile — one door per room, and it already exists.
            onOpenMember={peerId =>
              setRoute({
                name: 'peerProfile',
                peerId,
                from: route.from,
                via: { name: 'groupProfile', groupId: route.groupId },
              })
            }
            // Both deletes land here: the thread behind this screen is gone,
            // so back must not walk into it.
            onRoomGone={() => setRoute({ name: 'chats' })}
          />
        )}

        {route.name === 'photoViewer' && (
          <PhotoViewerScreen
            peerId={route.peerId}
            msgId={route.msgId}
            direction={route.direction}
            // A room row I authored can arrive as SHARED HISTORY — direction
            // 'in', authorId mine — and without knowing who "me" is the bar
            // would caption my own photo with my id fragment where the
            // thread says "You".
            selfId={profile?.userId}
            onClose={() =>
              setRoute({ name: 'thread', peerId: route.peerId, from: route.from })
            }
          />
        )}
    </>
  );

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: t.color.paperGround }]}
      // Horizontal edges too: ['top','bottom'] was
      // correct only while portrait-phone was the universe — the moment a
      // notched device goes landscape (the iPad flip brings rotation, and
      // Android tablets rotate today), content without left/right insets
      // slides under the sensor housing. Portrait phones report zero
      // horizontal insets, so compact is untouched; photoViewer keeps its
      // deliberate full-bleed [].
      edges={
        route.name === 'photoViewer'
          ? []
          : ['top', 'bottom', 'left', 'right']
      }
    >
      {projected ? (
        /* THE WIDE PROJECTION: list pane beside
           detail pane — the same route state a phone renders as one
           surface. Everything below the panes (calls, covers, the gone
           sheet) is full-WINDOW on every projection: a call or a cover
           over half a window would be a lie about what is on glass. */
        <View style={styles.panes}>
          {/* The LIST pane: the chats/calls list with the TabBar as its own
              rail — pane chrome now, not window chrome — sized to the
              designed bounds and claimed as a pane so its screens size
              against the pane, never the window. */}
          <View
            testID="list-pane"
            style={[
              styles.listPane,
              {
                width: listPaneWidth,
                borderRightWidth: t.hairline,
                borderRightColor: t.color.lineSoft,
              },
            ]}
          >
            <PaneWidthProvider width={listPaneWidth}>
              {listTab === 'calls' ? callsSurface : chatListSurface}
              <TabBar
                active={listTab}
                onSelect={tab => setRoute(tab === 'calls' ? { name: 'calls' } : { name: 'chats' })}
              />
            </PaneWidthProvider>
          </View>
          {/* The DETAIL pane: the routed surface, or the QuietRoom-seeded
              empty detail when the route IS a home list. Back state is
              untouched — backDestination/DEPTH survive and are re-read as
              "which pane pops": a destination of chats/calls closes this
              pane to empty; anything deeper moves within it. */}
          <View testID="detail-pane" style={styles.detailPane}>
            <PaneWidthProvider
              width={Math.max(0, paneAreaWidth - listPaneWidth)}
            >
              <RouteTransition
                routeKey={detailOpen ? routeKey(route) : 'empty-detail'}
                depth={detailOpen ? routeDepth(route) : DEPTH.chats}
                crossfade={false}
                // The edge swipe is DISABLED in wide: POP_DISTANCE and
                // GESTURE_FLOOR are window-relative, phone-tuned numbers —
                // 0.3 of a 13" window is not a gesture anyone means — and
                // re-scoping them to pane width is a recorded nicety, deliberately deferred. The chevron
                // and Android's hardware back still pop through the same
                // backDestination.
                canGoBack={false}
                onGoBack={() => goBack(true)}
                reduceMotion={reduceMotion}
              >
                {detailOpen ? routeSurface : <EmptyDetail profile={profile} />}
              </RouteTransition>
            </PaneWidthProvider>
          </View>
        </View>
      ) : (
        <>
          <RouteTransition
            routeKey={routeKey(route)}
            depth={routeDepth(route)}
            crossfade={route.name === 'photoViewer'}
            // photoViewer pops (hardware back, its own close control) but does
            // not SWIPE: the crossfade has no horizontal movement to drag.
            canGoBack={route.name !== 'photoViewer' && backDestination(route) !== null}
            onGoBack={() => goBack(true)}
            reduceMotion={reduceMotion}
          >
            {routeSurface}
          </RouteTransition>
          {/* OUTSIDE the transition, deliberately: the rail is chrome shared by
              both home surfaces, and inside it would fade and slide on every tab
              switch as though it were content. */}
          {(route.name === 'chats' || route.name === 'calls') &&
            profile &&
            // No rail under the naming moment: a first-run question with
            // tabs beneath it reads as a place to wander off from.
            !namingStep && (
            <TabBar
              active={route.name}
              onSelect={tab => setRoute(tab === 'calls' ? { name: 'calls' } : { name: 'chats' })}
            />
          )}
        </>
      )}
      {/* Calls are SIBLINGS of the router, not routes: a call must survive
          navigating to another chat.

          Mounted BELOW the capture cover and the app-switcher sheet on
          purpose. A call is the most sensitive surface this app has — it is
          the other person's face — so screen recording must blank it and the
          switcher snapshot must hide it, exactly as they do a conversation.
          Putting the call UI above them would have quietly exempted video
          from both. */}
      {call.name === 'incoming_ringing' && call.call && (
        <IncomingCallScreen
          peerId={call.call.peerId}
          peerName={callPeerName ?? personName(call.call.peerId)}
          peerAvatarB64={callPeerAvatar}
          withVideo={call.call.peerVideo}
          // Through `acceptIncomingCall`, never `accept()` directly: it asks
          // for the microphone (and camera) FIRST, as the three outgoing
          // paths do, so a first-ever call that is incoming does not put the
          // system prompts over the connecting screen after `didActivate` —
          // and a denied camera degrades the answer to audio rather than
          // promising `vid:true` to a caller who then stares at black.
          onAccept={() => void acceptIncomingCall(true)}
          // Both buttons called the same accept(), so "Answer without video"
          // answered WITH video: the camera came on for someone who had just
          // said not to.
          onAcceptAudioOnly={() => void acceptIncomingCall(false)}
          onDecline={() => void callController().decline()}
        />
      )}
      {/* ONE slot, two shapes: the full screen,
          or — minimized, on a workspace route, in a real session — the small
          draggable window over the app. The OUTER condition is the one the
          visible-surface model mirrors (`overlaysFromSiblings`): whichever
          shape renders, the 1:1 overlay is on glass, so the capture cover
          applies to the minimized window exactly as to the full screen, and
          every terminal path (relock's `endCallOnQuiesce`, hangup, the peer
          ending) unmounts both the same way — the machine goes idle. A relock
          also flips the route to 'locked', which `callOverlayAllowed` refuses
          before the machine has even finished ending: the surface behind the
          lock is the full screen, the one proven there. */}
      {call.name !== 'idle' &&
        call.name !== 'incoming_ringing' &&
        call.call &&
        (callMinimized &&
        callOverlayAllowed(route.name) &&
        (call.name === 'connected' ||
          call.name === 'reconnecting' ||
          call.name === 'ending') ? (
          <CallOverlay
            state={call}
            peerName={callPeerName ?? personName(call.call.peerId)}
            peerAvatarB64={callPeerAvatar}
            onRestore={() => setCallMinimized(false)}
            onHangup={() => void callController().hangup()}
          />
        ) : (
          <CallScreen
            state={call}
            peerName={callPeerName ?? personName(call.call.peerId)}
            peerAvatarB64={callPeerAvatar}
            muted={media.muted}
            videoEnabled={media.videoEnabled}
            speakerOn={media.speakerOn}
            frontCamera={media.frontCamera}
            quality={media.quality}
            qualityStatus={media.qualityStatus}
            pressureNotice={media.pressureNotice}
            pressureRestorable={media.pressureRestorable}
            onRestoreQuality={() => void restoreVideoQuality()}
            offerVoice={media.offerVoice}
            onSwitchToVoice={() => void switchToVoice()}
            onToggleMute={toggleMute}
            onToggleVideo={toggleVideo}
            onFlipCamera={() => void flipCamera()}
            onToggleSpeaker={() => void toggleSpeaker()}
            onHangup={() => void callController().hangup()}
            initialSwapped={callVideoPresentation.current.swapped}
            initialPipCorner={callVideoPresentation.current.pipCorner}
            onSwappedChange={swapped => {
              if (callVideoPresentation.current.cid === call.call?.cid) {
                callVideoPresentation.current.swapped = swapped;
              }
            }}
            onPipCornerChange={pipCorner => {
              if (callVideoPresentation.current.cid === call.call?.cid) {
                callVideoPresentation.current.pipCorner = pipCorner;
              }
            }}
            // Offered only where the window can take over: a connected or
            // reconnecting call, on a route and in a session the window is
            // allowed on. A ringing call keeps the full screen (its ringback
            // lives there), and a call over the lock route has nowhere to
            // minimize TO.
            onMinimize={
              (call.name === 'connected' || call.name === 'reconnecting') &&
              callOverlayAllowed(route.name)
                ? () => setCallMinimized(true)
                : undefined
            }
          />
        ))}
      {/* The small-group session, beside the router for the same reason the
          1:1 call is: navigating to another chat must not end it. Mounted
          below the capture cover and the app-switcher sheet, exactly as
          `CallScreen` is — a group call is no less sensitive than a 1:1 one. */}
      {groupView && (
        <GroupCallScreen
          view={groupView}
          nameFor={id => groupNames.get(id) ?? null}
          // The room arm of the dark rectangle (hardware report, "that
          // goes the same for room call"): `avatarFor` is optional, so this
          // prop going missing is a monogram on every tile with a green
          // suite — GroupCallScreen.test.tsx renders the real App to pin it.
          avatarFor={id => groupAvatars.get(id) ?? null}
          roomName={groupRoom?.roomId === groupView.roomId ? groupRoom.name : null}
          cameraOn={groupCameraOn}
          onToggleMute={() => toggleGroupMute()}
          // Unconditional, unlike the camera: group calls ship audio only, and
          // an audio call is exactly the one that needs a way off the earpiece.
          // Nothing is returned because nothing is fanned — see
          // `toggleGroupSpeaker`.
          onToggleSpeaker={() => void toggleGroupSpeaker()}
          onToggleCamera={
            groupView.video
              ? async () => {
                  const next = !groupCameraOn;
                  setGroupCameraOn(next);
                  // RETURNED, not swallowed: the per-leg outcome is what lets
                  // the screen name the people this toggle dropped and nobody
                  // else.
                  return groupCall().setVideoEnabled(next);
                }
              : undefined
          }
          // Offered only when there is somebody left in the room to add. The
          // screen itself decides whether it is DISABLED (the cap) and says
          // why; this only decides whether the affordance exists at all.
          onAdd={
            groupAddCandidates.length > 0 ? () => setGroupAdding(true) : undefined
          }
          onEnd={() => void groupCall().hangup()}
          onAnswer={() => void groupCall().answer()}
          onDecline={() => void groupCall().decline()}
        />
      )}
      {groupView && groupAdding && (
        <View style={[StyleSheet.absoluteFill, styles.addScrim]}>
          {/* The OPAQUE sheet is the picker's own container — never the
              full-screen layer above it. Painting the absoluteFill would
              blank the live call (every tile, every control) behind a paper
              field, and the seam below would then separate paper from paper.
              The layer stays transparent: it is layout (flex-end) and a touch
              catch, nothing else. */}
          <View
            style={{
              backgroundColor: t.color.paperLayer,
              borderTopWidth: t.hairline,
              borderTopColor: t.color.lineStrong,
            }}
          >
            <CallPicker
              // A session change must also destroy the picker's private
              // selections; hiding A's sheet for one render does not make those
              // dead choices belong to B when Add opens again.
              key={groupView.sessionKey}
              // The same map the tiles read, and the same absence: an unmapped
              // member arrives as null and the picker renders the placeholder.
              // It used to fall back to `personName(id)` with no name arguments
              // at all, which is the ULID fragment by construction — the exact
              // bug the in-call surfaces above were fixed for, one screen over.
              candidates={groupAddCandidates.map(id => ({
                peerId: id,
                name: groupNames.get(id) ?? null,
              }))}
              cap={smallGroupCallParticipantCap(groupView.video)}
              // The call already holds this many seats; see the prop's own note
              // on why counting only oneself here would be a lie.
              seatsTaken={groupView.roster.length}
              maxHeight={220}
              startLabel="Add to call"
              onCancel={() => setGroupAdding(false)}
              onStart={others => {
                setGroupAdding(false);
                void (async () => {
                  for (const id of others) {
                    // PER PERSON, so one refusal is one person not added rather
                    // than a silent end to the loop. The coordinator refuses
                    // anyone the room no longer holds (and anyone the cap or the
                    // epoch refuses); the same contract as every other call
                    // refusal here — the thing that would have happened simply
                    // does not.
                    await groupCall()
                      .addParticipant(id)
                      .catch(() => undefined);
                  }
                })().catch(() => undefined);
              }}
            />
          </View>
        </View>
      )}
      {/* Keeps the profile fresh when a card is saved from another surface. */}
      <ProfileWatcher onChange={refreshProfile} />
      {/* The account is gone: the one thing a silent re-auth may not stay
          silent about (see the latch above).

          `session.mode === 'real'` is read at render time, not captured: the
          latch can only be set by a real session, but it OUTLIVES a relock, and
          a duress unlock that inherited this sheet would tell a coercer
          something about a workspace they are not supposed to know exists
. Mounted below both covers, so a capture or an
          app-switcher snapshot still hides it. */}
      {(gone || deletionPending || identityMissing) && session.mode === 'real' &&
        route.name !== 'locked' && route.name !== 'loading' && (
        <View
          testID={deletionPending ? 'account-deletion-pending' : 'account-gone'}
          accessibilityViewIsModal
          accessibilityLabel={deletionPending ? 'Account deletion needs to finish' :
            `Tacendum. ${COPY_GONE.title}. ${COPY_GONE.line}`}
          style={[
            StyleSheet.absoluteFill,
            styles.cover,
            styles.gone,
            { backgroundColor: t.color.paperGround },
          ]}
        >
          <CoverBrand />
          <Text
            style={[
              t.type.bodyStrong,
              styles.goneTitle,
              { color: t.color.inkStrong },
            ]}
          >
            {deletionPending ? 'Account deletion needs to finish' : identityMissing
              ? 'This device has lost its identity' : COPY_GONE.title}
          </Text>
          <Text
            style={[
              t.type.compactBody,
              styles.captureCoverLine,
              { color: t.color.inkMuted },
            ]}
          >
            {freshStartConfirm
              ? 'Starting fresh does not confirm server deletion. The old account may still exist. It permanently erases the chats and credentials on this device. Your next setup gets a new Tacendum ID. Other linked devices keep their accounts.'
              : deletionPending
                ? 'Tacendum could not finish confirming deletion and clearing this device. Try again when you’re online. Setup can continue once this is complete.'
                : identityMissing
                  ? 'The private identity key is no longer on this device, so these credentials cannot restore it. You can start fresh, then recover a linked account grouping if one is available.'
                  : COPY_GONE.line}
          </Text>
          <PrimaryButton
            testID={freshStartConfirm ? 'account-start-fresh-confirm' :
              deletionPending ? 'account-deletion-retry' : 'account-start-fresh'}
            label={freshStartConfirm ? 'Erase this device and start fresh' :
              deletionPending ? 'Try again' : 'Start fresh'}
            busy={deletionBusy}
            onPress={() => {
              if (freshStartConfirm) void finishDeletionFromCover(true);
              else if (deletionPending) void finishDeletionFromCover(false);
              else setFreshStartConfirm(true);
            }}
            style={{ marginTop: 24 }}
          />
          {(gone || identityMissing) && deletionPending && !freshStartConfirm && (
            <TextAction label="Start fresh on this device" testID="account-deletion-abandon"
              onPress={() => setFreshStartConfirm(true)} />
          )}
          {freshStartConfirm && (
            <TextAction label="Cancel" onPress={() => setFreshStartConfirm(false)} />
          )}
        </View>
      )}
      {/* Capture cover: while the screen is recorded, mirrored, or cast,
          conversations wait behind an opaque paper sheet (formal route —
          UIScreen.isCaptured; screenshots cannot be blocked, only disclosed).
          Whether it applies is the visible-surface model's fact: the
          lock/landing/loading screens alone stay uncovered, but a live call
          overlay over ANY route — including the lock screen — is covered
          (the design as amended, the found-shipped-defect fix and its addendum). */}
      {shouldBlank && surfaceFacts.captureCoverApplies && (
        <View
          testID="capture-cover"
          accessible
          accessibilityViewIsModal
          accessibilityLabel={`Tacendum. ${COPY_COVER.line}`}
          style={[
            StyleSheet.absoluteFill,
            styles.cover,
            { backgroundColor: t.color.paperGround },
          ]}
        >
          {/* The photo viewer runs a light-content status bar; over light
              paper those glyphs vanish. Mounting here outranks it, in
              whichever ink the current ground needs. */}
          <StatusBar
            barStyle={t.scheme === 'dark' ? 'light-content' : 'dark-content'}
          />
          <CoverBrand />
          <Text
            style={[
              t.type.compactBody,
              styles.captureCoverLine,
              { color: t.color.inkMuted },
            ]}
          >
            {COPY_COVER.line}
          </Text>
        </View>
      )}
      {/* App-switcher snapshot cover: whenever the app is not active, an
          opaque paper sheet hides every surface. */}
      {!appActive && (
        <View
          testID="privacy-overlay"
          accessible
          accessibilityLabel="Tacendum"
          style={[
            StyleSheet.absoluteFill,
            styles.cover,
            { backgroundColor: t.color.paperGround },
          ]}
        >
          {/* Same status-bar override as the capture cover: the snapshot must
              not show mismatched glyphs when leaving the photo viewer. */}
          <StatusBar
            barStyle={t.scheme === 'dark' ? 'light-content' : 'dark-content'}
          />
          <CoverBrand />
        </View>
      )}
    </SafeAreaView>
  );
}

/** Identity of the current surface — a change drives the route transition. */
function routeKey(route: Route): string {
  // A member's profile reached through a room is a different surface from
  // the same person's profile reached from their thread: the key says so,
  // or the transition between the two would not run.
  if (route.name === 'peerProfile') {
    return `${route.name}:${route.peerId}${route.via ? `:via:${route.via.groupId}` : ''}`;
  }
  return route.name === 'thread'
    ? `${route.name}:${route.peerId}:${route.focusedApprovalQ ?? ''}`
    : route.name;
}

/**
 * How deep each surface sits. A move to an equal or greater depth enters from
 * the right; a shallower one enters from the left, so back stops looking
 * identical to forward. Hand-maintained: add a row whenever a route is added
 * (the Record type will refuse to compile until you do).
 */
const DEPTH: Record<Route['name'], number> = {
  loading: 0,
  locked: 0,
  landing: 0,
  // The wall sits at the pre-workspace floor with the lock and the landing
  // screen: it is entered from every depth and left only by starting over,
  // so neither direction should read as a descent.
  updateRequired: 0,
  register: 1,
  chats: 1,
  // A sibling of chats, not a descent: switching tabs slides neither way.
  calls: 1,
  attention: 2,
  newChat: 2,
  newRoom: 2,
  thread: 2,
  profile: 2,
  settings: 3,
  peerProfile: 3,
  groupProfile: 3,
  photoViewer: 3,
  // Device linking: the roster sits under settings; the scan side
  // under the roster. The confirm surface arrives OVER a home surface (a
  // notice navigates to it), so it sits at thread depth.
  linkedDevices: 4,
  linkDevice: 5,
  linkConfirm: 2,
  // The email surface sits under settings like the roster; discover
  // descends from newChat; recover sits beside register.
  accountEmail: 4,
  // The phone surface is the email surface's sibling — same depth.
  accountPhone: 4,
  // The username surface, the third identifier sibling — same depth.
  accountUsername: 4,
  discover: 3,
  recover: 1,
};

/**
 * DEPTH, with the one surface that sits deeper than its name: a room
 * member's profile is opened FROM the room profile, and both are at 3, so an
 * equal-depth pop back to the room would animate FORWARD. */
function routeDepth(route: Route): number {
  return DEPTH[route.name] + (route.name === 'peerProfile' && route.via ? 1 : 0);
}

/**
 * Where a surface pops back to, or null if it is a root. The router does not
 * keep a stack, so each destination is stated once here and shared by the
 * screen's own Back control, the edge swipe, and Android's hardware back —
 * every pushed surface must answer, or the hardware back backgrounds the app
 * from a screen whose own chevron knows better. Each case mirrors the
 * visible control on that screen: whenever a screen's onBack/onClose prop
 * changes, this switch changes with it.
 *
 * photoViewer answers here (hardware back must close it to its thread, as
 * onClose does) but is excluded from the SWIPE at the canGoBack call site:
 * its transition is a pure crossfade — a horizontal drag between paper and
 * black reads as a glitch — so it has no movement to drive a swipe with.
 *
 * EXPORTED for `App.routes.test.tsx`, which asserts this switch is TOTAL:
 * a missing case otherwise falls to `default: return null`, so the
 * chevron, the edge swipe and Android's hardware back all do nothing and the
 * system backgrounds the app from a pushed surface. Nothing else calls it
 * from outside this file.
 */
export function backDestination(route: Route): Route | null {
  switch (route.name) {
    case 'register':
      return { name: 'landing' };
    case 'newChat':
      return { name: 'chats' };
    case 'newRoom':
      return { name: 'chats' };
    case 'attention':
      return { name: 'chats' };
    case 'thread':
      // A thread respects its origin: opened from the Calls tab, its chevron
      // reads route.from and goes back to calls — back agrees.
      return route.from === 'calls'
        ? { name: 'calls' }
        : route.from === 'attention'
          ? { name: 'attention' }
          : { name: 'chats' };
    case 'profile':
      // The Calls tab has its own profile door: opened there,
      // Back returns there. Unmarked doors are the chat list's, as they
      // always were.
      return route.from === 'calls' ? { name: 'calls' } : { name: 'chats' };
    case 'settings':
      if (route.section) return { name: 'settings', from: route.from };
      // Reached through Profile, Back is Profile. Reached through the chat
      // list's App Lock nudge, Back is the chat list — a first-run nudge
      // must not leave a person somewhere they never asked to go.
      return route.from === 'chats' ? { name: 'chats' } : { name: 'profile' };
    case 'linkedDevices':
      // Settings' own origin rides back out with it: a roster opened from
      // the App Lock nudge's Settings pops to a Settings that still knows
      // it came from the chat list.
      return { name: 'settings', from: route.from, section: 'account' };
    case 'linkDevice':
      return { name: 'linkedDevices', from: route.from };
    case 'linkConfirm':
      // The confirm surface arrives OVER a home surface, and either home
      // surface can be the one it arrived over.
      return route.from === 'calls' ? { name: 'calls' } : { name: 'chats' };
    case 'accountEmail':
      return route.via === 'username'
        ? { name: 'accountUsername', from: route.from }
        : { name: 'settings', from: route.from, section: 'account' };
    case 'accountPhone':
      return { name: 'settings', from: route.from, section: 'account' };
    case 'accountUsername':
      return { name: 'settings', from: route.from, section: 'account' };
    case 'discover':
      return { name: 'newChat' };
    case 'recover':
      // Back agrees with the door it came through: the landing surface
      // pre-registration, the workspace after (the screen's own chevron
      // makes the same choice on `profile`).
      return route.from === 'chats' ? { name: 'chats' } : { name: 'landing' };
    case 'peerProfile':
      // A room member's profile pops back to the room it was opened
      // from; one opened from a thread pops to that thread.
      return route.via
        ? { name: 'groupProfile', groupId: route.via.groupId, from: route.from }
        : { name: 'thread', peerId: route.peerId, from: route.from };
    case 'groupProfile':
      return { name: 'thread', peerId: route.groupId, from: route.from };
    case 'photoViewer':
      // The origin rides through: the recreated thread must still know it
      // came from Calls, or the SECOND back lands on the wrong tab.
      return { name: 'thread', peerId: route.peerId, from: route.from };
    default:
      return null;
  }
}

/** Every field of the stored card, so an unchanged row cannot re-render. */
function sameProfile(a: db.ProfileRow, b: db.ProfileRow): boolean {
  return (
    a.userId === b.userId &&
    a.registrationId === b.registrationId &&
    a.displayName === b.displayName &&
    a.about === b.about &&
    a.profileVersion === b.profileVersion &&
    a.avatarB64 === b.avatarB64
  );
}

/** Leading 24pt of the screen: the only strip a back swipe may start in. */
const EDGE_WIDTH = 24;
/** Height of the composer plus its emoji drawer, kept out of the gesture. */
const GESTURE_FLOOR = 140;
/** Fraction of the width, or the flick velocity, that commits the pop. */
const POP_DISTANCE = 0.3;
const POP_VELOCITY = 0.5;

/**
 * Route change: a short fade and a signed 6pt slide, per the motion spec —
 * forward enters from +6, back from -6. Reduce Motion removes both; the
 * surface simply appears.
 *
 * Also owns the interactive back swipe, because the surface it drags is this
 * component's own transform. Core PanResponder only: gesture-handler and
 * reanimated are both new native pods.
 */
function RouteTransition({
  routeKey: key,
  depth,
  crossfade,
  canGoBack,
  onGoBack,
  reduceMotion,
  children,
}: {
  routeKey: string;
  depth: number;
  crossfade: boolean;
  canGoBack: boolean;
  /** Returns false if there was nothing to pop, so the drag can settle back. */
  onGoBack: () => boolean;
  reduceMotion: boolean;
  children: React.ReactNode;
}) {
  const t = useTheme();
  const { width, height } = useWindowDimensions();
  const opacity = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const previous = useRef(key);
  const previousDepth = useRef(depth);
  const previousCrossfade = useRef(crossfade);
  const [dragging, setDragging] = useState(false);

  /** The responder is built once; everything it needs to read at touch time
   * lives here so a re-render never has to rebuild it. */
  const live = useRef({ canGoBack, onGoBack, reduceMotion, width, height });
  live.current = { canGoBack, onGoBack, reduceMotion, width, height };

  // A layout effect, not an effect: the reset below has to land in the same
  // commit as the new children. Run after the commit, a slow frame presents
  // the incoming surface at full opacity and zero offset before it snaps back
  // to the start of the animation. setValue on a native-driven value forwards
  // straight to the native node, so it is safe from here.
  useLayoutEffect(() => {
    if (previous.current === key) return;
    const direction = depth >= previousDepth.current ? 1 : -1;
    // Paper never slides onto or off the photo viewer's black ground.
    const slide = !crossfade && !previousCrossfade.current;
    previous.current = key;
    previousDepth.current = depth;
    previousCrossfade.current = crossfade;
    if (reduceMotion) {
      opacity.setValue(1);
      translateX.setValue(0);
      return;
    }
    opacity.setValue(0);
    translateX.setValue(slide ? 6 * direction : 0);
    const entrance = Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: t.motion.surface,
        easing: t.motion.easing,
        useNativeDriver: true,
      }),
      Animated.timing(translateX, {
        toValue: 0,
        duration: t.motion.route,
        easing: t.motion.easing,
        useNativeDriver: true,
      }),
    ]);
    entrance.start();
    // A running timing animation keeps its own timer and reads the easing
    // function on every frame. Left alive past this surface it both fights the
    // next route's entrance and — once the tree is gone — ticks against a torn
    // down environment.
    return () => entrance.stop();
  }, [key, depth, crossfade, reduceMotion, opacity, translateX, t.motion]);

  const responder = useMemo(() => {
    const rest = () => {
      if (live.current.reduceMotion) {
        translateX.setValue(0);
        setDragging(false);
        return;
      }
      Animated.timing(translateX, {
        toValue: 0,
        duration: t.motion.micro,
        easing: t.motion.easing,
        useNativeDriver: true,
      }).start(() => setDragging(false));
    };
    return PanResponder.create({
      // Only a move can claim the surface — onStart* stays unset, so every tap
      // and every vertical scroll reaches the screen untouched.
      onMoveShouldSetPanResponder: (e, g) => {
        const s = live.current;
        if (!s.canGoBack) return false;
        // pageX - dx is where the finger landed.
        if (e.nativeEvent.pageX - g.dx > EDGE_WIDTH) return false;
        if (g.dx <= 8) return false;
        if (Math.abs(g.dx) <= Math.abs(g.dy) * 2) return false;
        // Keeps the composer and its horizontal emoji drawer out of the zone.
        return e.nativeEvent.pageY < s.height - GESTURE_FLOOR;
      },
      // Once the edge is claimed, a child list must not steal the drag.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => setDragging(true),
      onPanResponderMove: (_e, g) => {
        // Never negative: this gesture only ever reveals what is behind.
        translateX.setValue(Math.max(0, g.dx));
      },
      onPanResponderRelease: (_e, g) => {
        const s = live.current;
        if (g.dx <= s.width * POP_DISTANCE && g.vx <= POP_VELOCITY) {
          rest();
          return;
        }
        if (s.reduceMotion) {
          if (!s.onGoBack()) rest();
          else setDragging(false);
          return;
        }
        Animated.timing(translateX, {
          toValue: s.width,
          duration: t.motion.route,
          easing: t.motion.easing,
          useNativeDriver: true,
        }).start(() => {
          // The layout effect above resets the transform in the same commit
          // as the incoming children, so the surface never shows at width.
          if (!live.current.onGoBack()) rest();
          else setDragging(false);
        });
      },
      onPanResponderTerminate: rest,
    });
  }, [translateX, t.motion]);

  return (
    <Animated.View
      style={[styles.container, { opacity, transform: [{ translateX }] }]}
      {...responder.panHandlers}
    >
      {children}
      {/* Depth during the drag is a seam, never a shadow: one hairline on the
          leading edge so paper reads as sliding over paper. Rendered only
          while dragging, so it cannot flash during a route transition. */}
      {dragging && (
        <View
          pointerEvents="none"
          style={[
            styles.leadingEdge,
            { width: t.hairline, backgroundColor: t.color.lineSoft },
          ]}
        />
      )}
    </Animated.View>
  );
}

/** 80ms: long enough to coalesce a draining backlog, short enough that a card
 * saved on another surface still lands before the eye notices. */
const PROFILE_REFRESH_MS = 80;

/** Subscribes to messaging so a saved profile card refreshes the app's copy. */
function ProfileWatcher({ onChange }: { onChange: () => void }) {
  useEffect(() => {
    // notify() fires on every receipt, every inbound frame, every socket
    // transition and every attachment tick, and each one used to re-read the
    // profile and re-render the whole router. Coalesce a burst into one read
    // at the end of an 80ms window — a window rather than a resetting
    // debounce, so a continuous drain still refreshes instead of starving.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = messaging.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, PROFILE_REFRESH_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [onChange]);
  return null;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  /** The wide projection's row of panes. The list pane's width and its
   * hairline seam are inline (token-driven); the detail pane takes the rest. */
  panes: { flex: 1, flexDirection: 'row' },
  listPane: { flexDirection: 'column' },
  detailPane: { flex: 1 },
  /** Covers centre their mark; only the lock screen uses the quarter line. */
  cover: { alignItems: 'center', justifyContent: 'center' },
  /** The boot frame centres its arriving mark; covers keep the quarter line. */
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  leadingEdge: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  captureCoverLine: { marginTop: 16, textAlign: 'center' },
  /**
   * The in-call Add picker sits on an OPAQUE paper sheet over the call's dark
   * surface — no translucent scrims anywhere (the emoji rail's precedent);
   * the hairline seam above the picker is what keeps the two surfaces from
   * reading as one. This is the LAYER, not the sheet: it is transparent, and
   * only pins the sheet to the bottom edge (and swallows taps aimed at the
   * call behind it). The paper token and the seam are on the sheet itself, at
   * the call site, so the call stays visible around it — an opaque element
   * seamed to its host, exactly as the rail does. */
  addScrim: { justifyContent: 'flex-end' },
  /** The gone sheet holds prose, not a single line: keep it off the edges. */
  gone: { paddingHorizontal: 32 },
  goneTitle: { marginTop: 24, textAlign: 'center' },
});

export default App;
