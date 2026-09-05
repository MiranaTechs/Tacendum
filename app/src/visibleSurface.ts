/**
 * The VISIBLE-SURFACE model.
 *
 * "What is the screen actually showing" as a first-class, tested fact: the
 * ROUTE plus the OVERLAY SIBLINGS, never `route.name` alone. The call
 * surfaces render as full-window router siblings over any route and start
 * before the lock verdict by design (the ring must not wait for a passcode),
 * so any security decision keyed on the route name alone is reasoning about
 * a screen that may not be the one on glass.
 *
 * Exactly FOUR consumers read these facts, and no fifth exists without a
 * plan amendment:
 *
 *   1. screenshot disclosure — which conversation a screenshot is disclosed
 *      to (`screenshotDisclosureTo`);
 *   2. the capture-cover exemption — whether the opaque cover renders while
 *      the screen is recorded, mirrored or cast (`captureCoverApplies`);
 *   3. preview-lease renewal — whether what is on screen PROVES a workspace
 *      is open (`provesWorkspaceOpen`);
 *   4. push-nav redemption — whether a tap intent may be consumed here and
 *      whether it may land here (`pushNavRedeemable` / `pushNavLandable`).
 *
 * THE ONE DELIBERATE BEHAVIOR CHANGE this extraction ships (a
 * found-shipped-defect amendment): the capture-cover exemption now keys off the visible
 * surface, not the route name. Before this extraction, `blankableRoute` exempted
 * `locked`/`landing`/`loading` while a live incoming ring or video call — a
 * router sibling, mounted BELOW the cover precisely so recording blanks it
 * — was composited over any of those routes uncovered: over the lock
 * screen (the found defect), and equally over `loading` (the designed
 * cold-ring window — calls start at mount, before the verdict) and over
 * `landing` (an unlock arm that finds no profile while a pre-verdict ring
 * is live — only relock/account deletion end calls, the unlock arms do
 * not). After it: an exempt route with NO overlay stays uncovered (on
 * locked, a person must be able to unlock, or duress-unlock, while
 * mirroring — the pad never echoes digits and the screen holds nothing to
 * read); ANY live call overlay is covered, whatever route sits behind it —
 * the exemption's rationale is a fact about the ROUTE, and the thing on
 * glass is the CALL. Every other fact is provably identical to the
 * previous route-name answers for every no-overlay case
 * (visible-surface.test.ts pins the full 17-route × overlay matrix, per
 * cell).
 *
 * SHAPE, delivered in two halves: `VisibleSurface.routes` is a list, not a
 * single route. In compact it holds exactly the router's current route
 * (`compactVisibleSurface`); the wide two-pane projection (
 * `wideVisibleSurface`) passes one entry per visible pane and the consumers
 * did not change — the point being that this fact was tested BEFORE a
 * second visible surface existed.
 */

/** The 21-name Route union, by name (the route
 * model survives; wide is a projection, never a second router). App.tsx's
 * `Route` variants are structurally assignable to `VisibleRoute`. The three
 * linking routes, the three identifier/discovery/
 * recovery routes, and the phone surface joined THROUGH this module — new names in the union,
 * and NO fifth consumer of the facts was added any time. */
export type SurfaceRouteName =
  | 'loading'
  | 'locked'
  | 'landing'
  | 'register'
  | 'chats'
  | 'calls'
  | 'newChat'
  | 'newRoom'
  | 'thread'
  | 'profile'
  | 'settings'
  | 'peerProfile'
  | 'groupProfile'
  | 'photoViewer'
  // Device linking: the scan side, the
  // new-device confirm surface, and the roster. All three are covered
  // during capture (ceremony codes and device lists are sensitive), prove
  // an open workspace, and disclose no conversation content.
  | 'linkDevice'
  | 'linkConfirm'
  | 'linkedDevices'
  // Identifier + discovery + recovery, joined
  // THROUGH this module — no fifth consumer of the facts.
  // accountEmail and discover are ordinary workspace surfaces (covered
  // during capture: typed addresses are sensitive); recover is
  // register-class — reachable from the landing surface BEFORE any
  // workspace exists, so it proves nothing and redeems nothing.
  | 'accountEmail'
  // The phone surface (a new name in
  // the union, NO fifth consumer): accountEmail's sibling and the same
  // ordinary workspace surface to every consumer — a typed number on glass
  // is exactly what the capture cover exists for. Dark behind the
  // build-pinned PHONE_UI_ENABLED; the facts hold either way.
  | 'accountPhone'
  // The username surface (a third
  // time: a new name in the union, NO fifth consumer): the identifier
  // siblings' sibling and the same ordinary workspace surface to every
  // consumer — a typed handle on glass is what the capture cover exists
  // for. Dark behind the build-pinned USERNAME_UI_ENABLED; the facts hold
  // either way.
  | 'accountUsername'
  | 'discover'
  | 'recover'
  // The update wall (§9 rule 9 a fourth time: a new
  // name in the union, NO fifth consumer). Locked/landing/loading's class,
  // for their reason — an empty screen a person must keep access to while
  // mirroring, with nothing on it to read — and register-class to every
  // other consumer: it stands in front of a workspace that was never
  // opened, so it proves none and redeems no push tap.
  | 'updateRequired';

/** A routed surface that is visible right now. `peerId` rides along where
 * the route carries one; disclosure is keyed on the NAME (thread /
 * photoViewer — the two routes that show conversation CONTENT), never on
 * the mere presence of a peerId: peerProfile has a peerId and shows no
 * messages, and a notice to its peer would manufacture false evidence. */
export interface VisibleRoute {
  name: SurfaceRouteName;
  peerId?: string;
}

/**
 * The full-window siblings that render OVER the routes. Both call shapes
 * are here because both are mounted below the capture cover on purpose —
 * a call is the most sensitive surface this app has; it is the other
 * person's face.
 */
export interface OverlayFacts {
  /** The 1:1 call surface: incoming ring, dialing, or live call. */
  call: boolean;
  /** The small-group call surface. */
  groupCall: boolean;
}

/** What is on screen: the visible routed surface(s) plus the overlays. */
export interface VisibleSurface {
  routes: readonly VisibleRoute[];
  overlays: OverlayFacts;
}

/**
 * The derived security facts — everything the four consumers may read.
 * Facts about ROUTES deliberately ignore the overlays everywhere except the
 * cover: a call proves nothing about the lock verdict (it starts before
 * it), so it may neither renew a preview lease, nor redeem a tap intent,
 * nor add a disclosure target. Only the cover cares that a call is on
 * glass, because the cover's job is exactly "is anything sensitive
 * composited right now".
 */
export interface VisibleSurfaceFacts {
  /** Peers whose conversation CONTENT is visible: a screenshot taken now is
   * disclosed to each (empty = nothing to disclose). Compact yields zero or
   * one; the shape is a list so a pane projection can answer without the
   * consumer changing. */
  screenshotDisclosureTo: readonly string[];
  /** The capture cover renders while the screen is captured. False only
   * when EVERY visible surface is exempt: exempt routes (locked / landing /
   * loading — empty screens a person must keep access to) and no overlay.
   * Any live call overlay makes this true, whatever route sits behind it —
   * The design as amended. */
  captureCoverApplies: boolean;
  /** Some visible route PROVES a workspace is open (chats, a thread,
   * settings, …). Gates preview-lease renewal: `session.mode` defaults to
   * 'real' at launch, so "not locked" alone would also match
   * loading/landing/register and let a crash-stale lease be extended
   * without any unlock having happened. */
  provesWorkspaceOpen: boolean;
  /** A push tap intent may be CONSUMED from here: no visible route is
   * landing or register — surfaces with no workspace for a thread to live
   * in. (The warm-tap path additionally gates on transport resume; that
   * gate is the resume's, not this model's.) */
  pushNavRedeemable: boolean;
  /** A consumed tap intent may LAND here: no visible route is locked — a
   * redemption resolving after a relock must wait for the unlock arm's own
   * redemption instead of navigating under the lock screen. */
  pushNavLandable: boolean;
}

/** The routes that stay visible during a capture when nothing else is on
 * glass: nothing to read, and the person must keep access (unlock — or
 * duress-unlock — while mirroring; the pad never echoes digits). */
const CAPTURE_EXEMPT: ReadonlySet<SurfaceRouteName> = new Set([
  'locked',
  'landing',
  'loading',
  // The update wall carries a title, one sentence, and the way to the
  // store. Covering it would hide the only control that ends the state
  // from someone mirroring their screen for help.
  'updateRequired',
]);

/** The routes that exist WITHOUT an open workspace. Everything else can
 * only be on screen because a verdict landed and a workspace opened. */
const NO_WORKSPACE: ReadonlySet<SurfaceRouteName> = new Set([
  'locked',
  'loading',
  'landing',
  'register',
  // Register-class: the recover surface exists from
  // the landing screen, before any profile or verdict — it can be on glass
  // with no workspace open, so it must prove nothing.
  'recover',
  // The update wall replaces the workspace opening rather than following
  // it: `messaging.start` is never reached from here, so nothing behind it
  // is open.
  'updateRequired',
]);

/** The two routes that show conversation content, by name. */
const DISCLOSES_CONTENT: ReadonlySet<SurfaceRouteName> = new Set([
  'thread',
  'photoViewer',
]);

/** The sibling mounts as App.tsx holds them — both projections read the
 * SAME shape, so the overlay derivation cannot fork between them. */
interface SiblingMounts {
  call: { name: string; call: object | null };
  groupCall: object | null;
}

/**
 * The overlay half of a surface. ONE derivation for both projections: the
 * conditions mirror the render conditions exactly — IncomingCallScreen
 * renders at `incoming_ringing`, CallScreen at every other non-idle state,
 * so the 1:1 overlay is on glass iff the machine is non-idle with a call
 * context; the group surface is on glass iff a session view exists. If a
 * render condition ever changes, change it here in the same commit — this
 * pair is one fact.
 *
 * The MINIMIZED call did not change it: App.tsx swaps the full
 * CallScreen for the small CallOverlay window INSIDE the same non-idle
 * condition, so a minimized call is a 1:1 overlay on glass exactly as the
 * full screen is — the other person's face in a corner is still the other
 * person's face, and the capture cover still applies. This model does not
 * know about "minimized", on purpose.
 */
function overlaysFromSiblings(siblings: SiblingMounts): OverlayFacts {
  return {
    call: siblings.call.name !== 'idle' && siblings.call.call !== null,
    groupCall: siblings.groupCall !== null,
  };
}

/**
 * The compact surface: the router's single route plus the overlay siblings.
 */
export function compactVisibleSurface(
  route: VisibleRoute,
  siblings: SiblingMounts,
): VisibleSurface {
  return {
    routes: [route],
    overlays: overlaysFromSiblings(siblings),
  };
}

/**
 * The wide two-pane surface: ONE ENTRY PER VISIBLE PANE,
 * and the four consumers did not
 * change. The LIST pane's route (chats or calls) rides first; the DETAIL
 * pane's route second, when a detail surface is open. `detail: null` is the
 * QuietRoom-seeded empty-detail surface: it shows no routed content, so it
 * contributes no entry and the surface is the list alone. The overlays are
 * compact's exactly — calls stay full-window router siblings on every
 * surface, so the pane projection changes nothing about what a call
 * covers or proves.
 *
 * Discharged here rather than re-litigated per consumer: with a thread
 * open the wide surface is [{chats}, {thread, peerId}] — screenshot
 * disclosure names the visible thread even though a route named 'chats' is
 * on glass beside it, because every fact derives from EVERY visible route,
 * never from one name.
 */
export function wideVisibleSurface(
  list: VisibleRoute,
  detail: VisibleRoute | null,
  siblings: SiblingMounts,
): VisibleSurface {
  return {
    routes: detail === null ? [list] : [list, detail],
    overlays: overlaysFromSiblings(siblings),
  };
}

/** Derive the security facts from a visible surface. Pure, total, cheap —
 * called every render and from event handlers via a ref. */
export function deriveSurfaceFacts(
  surface: VisibleSurface,
): VisibleSurfaceFacts {
  const { routes, overlays } = surface;
  const anyOverlay = overlays.call || overlays.groupCall;
  const disclosureTo: string[] = [];
  for (const r of routes) {
    if (DISCLOSES_CONTENT.has(r.name) && r.peerId !== undefined) {
      if (!disclosureTo.includes(r.peerId)) disclosureTo.push(r.peerId);
    }
  }
  return {
    screenshotDisclosureTo: disclosureTo,
    captureCoverApplies:
      anyOverlay || routes.some(r => !CAPTURE_EXEMPT.has(r.name)),
    provesWorkspaceOpen: routes.some(r => !NO_WORKSPACE.has(r.name)),
    pushNavRedeemable: routes.every(
      // `recover` refuses redemption with `register`: it is reachable
      // pre-workspace, and the conservative answer — wait for a surface
      // that provably has somewhere for a thread to live — fails safe on
      // its post-registration visits too. `updateRequired` refuses for the
      // same reason and more plainly: a tap consumed there is spent, and
      // the thread it names cannot open until the app is updated.
      r =>
        r.name !== 'landing' &&
        r.name !== 'register' &&
        r.name !== 'recover' &&
        r.name !== 'updateRequired',
    ),
    // `updateRequired` is here as well as in the list above, and it has to
    // be: refusing to CONSUME a tap on the wall says nothing about a tap
    // consumed a moment earlier, on `chats`, whose shared-state read is
    // still in flight when the gate raises the wall. Landing that thread put
    // a full workspace surface on top of a screen the gate says nothing is
    // reachable from, over a workspace this build has just been told it may
    // not use. The lock screen refuses for the same reason and longer.
    pushNavLandable: routes.every(
      r => r.name !== 'locked' && r.name !== 'updateRequired',
    ),
  };
}
