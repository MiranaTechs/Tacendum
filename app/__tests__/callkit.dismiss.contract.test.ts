/**
 * A DISMISSAL NAMES THE PLACEHOLDER IT ENDS — the NATIVE half.
 *
 * The JS side decides WHICH ring a verdict was about; the native side is what
 * makes a wrong answer harmless. `CallKitCenter.dismissPendingIncomingCall`
 * fires only while `pendingPush` still holds both that caller AND that exact
 * cid, so a verdict landing after the placeholder was replaced is a strict
 * no-op instead of ending a ring it never decided — and ending one there is
 * expensive: the body clears `pendingAnswered` (an answer the person already
 * tapped) and abandons a parked rebind (a call that then never re-rings).
 *
 * The correlation only works because native PUBLISHES the ringing
 * placeholder's cid. The push's own cid is the wrong answer: `alreadyRinging`
 * deliberately leaves `pendingPush` on the FIRST ring while still emitting
 * `voipPush` for the second, so from push #2 onward the cid JS is handed names
 * a throwaway and a dismissal tagged with it would match nothing — a ring
 * stuck to the 75-second watchdog, which is as much a defect as a suppressed
 * one.
 *
 * `CallKitCenter.swift` imports CallKit, PushKit and WebRTC, so it cannot join
 * the standalone `tests/main.swift` harness, and this repo has no XCTest
 * target — a test that only runs inside a full Xcode build is a test that does
 * not run. So, exactly as nse.blocked.suppress.test.ts pins the NSE's blocked
 * branch and privacy.manifest.test.ts pins an ios/ artifact, these are pins on
 * the SOURCE. Deliberately, nothing correctness-critical rests on them: if the
 * binary ignored `cid` entirely, every defect this round closed would still be
 * closed by the JS half, and these pins would only stop the defence in depth
 * from being deleted in silence.
 */

// `require` rather than `import`, and `declare` rather than @types/node: the
// app's tsconfig carries `types: ["jest"]` only. Same idiom as
// nse.blocked.suppress.test.ts. The bare export makes this a MODULE so its
// declarations stay its own.
export {};
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: string) => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };
declare const __dirname: string;

const IOS = '../modules/tacendum-call/ios';
const center = readFileSync(join(__dirname, IOS, 'CallKitCenter.swift'), 'utf8');
const impl = readFileSync(join(__dirname, IOS, 'TacendumCallImpl.swift'), 'utf8');
const bridge = readFileSync(join(__dirname, IOS, 'TacendumCall.mm'), 'utf8');
const spec = readFileSync(
  join(__dirname, '../modules/tacendum-call/src/index.ts'),
  'utf8',
);

/** The guard block, from the signature to its closing `else {`. */
function guardBlock(): string {
  const at = center.indexOf('@objc public func dismissPendingIncomingCall(');
  expect(at).toBeGreaterThan(-1);
  const end = center.indexOf('else {', at);
  expect(end).toBeGreaterThan(at);
  return center.slice(at, end);
}

describe('the native dismissal is keyed on the ring, not only the caller', () => {
  it('takes the cid and requires the pending placeholder to match it', () => {
    expect(center).toContain(
      '@objc public func dismissPendingIncomingCall(peerId: String, reason: String, cid: String)',
    );
    expect(guardBlock()).toContain('pending.cid == cid');
  });

  it('an absent cid degrades to the caller-keyed match', () => {
    // CONSTRAINT 5. A JS layer older than the tag sends '', and every
    // dismissal must then behave exactly as it did before the tag existed. A
    // guard that demanded a cid would silently stop dismissing anything.
    expect(guardBlock()).toContain('cid.isEmpty ||');
    expect(guardBlock()).toContain('peerId.isEmpty ||');
  });

  it('the push publishes the cid of the ring that is actually UP', () => {
    // Not `cid` — see `alreadyRinging`. The sink, both emit sites, the
    // per-caller match inside the helper, and the key that carries it across
    // the bridge: any one of them dropped leaves JS naming a throwaway.
    expect(center).toContain('func voipPush(cid: String, from: String, ringCid: String)');
    expect(center).toContain('private func ringingCid(for from: String) -> String');
    expect(center).toContain('guard let pending = pendingPush, pending.from == from');
    const emits = center.match(/voipPush\(cid: cid, from: from, ringCid: self\.ringingCid\(for: from\)\)/g);
    expect(emits).toHaveLength(2);
    expect(impl).toContain('func voipPush(cid: String, from: String, ringCid: String)');
    expect(impl).toContain('"ringCid": ringCid');
  });

  it('the ObjC bridge forwards the cid', () => {
    // The generated Swift selector. A `.mm` left on the two-argument one is a
    // build failure rather than a silent revert, but the pin costs nothing and
    // names the coupling.
    expect(bridge).toContain('dismissPendingIncomingCallWithPeerId:peerId reason:reason cid:cid');
  });

  it('the event schema tolerates a binary that predates ringCid', () => {
    // The weakest pin here, and deliberately so: this is plumbing, and the
    // behavioural pin is call.controller.test.ts's 'degrades to the
    // caller-keyed match when native publishes no ring cid'. `.min(1)` here
    // would drop every push from an older binary — a phone that stops ringing.
    expect(spec).toContain("ringCid: z.string().default('')");
  });
});
