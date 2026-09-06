/**
 * THE BOUNDED RE-SWEEP — what makes a five-minute timer mean five minutes.
 *
 * `sweepDisappearing` runs on thread-open and on foreground: the two moments
 * a person is actually looking. That is enough for a week and a lie for five
 * minutes, because between two looks nothing runs at all — the shortest
 * option would have meant "gone whenever you next happen to open this".
 * A timer option that overstates what the build does is the same defect as a
 * control that does nothing, so the option and the timer ship together.
 *
 * The properties worth pinning are the ones a careless implementation gets
 * wrong: the re-sweep must not RE-ARM (expiry is stamped at read time, so a
 * background pass that armed anything would start the clock on a message
 * nobody has looked at), it must not stack, it must not outlive the session,
 * and its delay must not overflow `setTimeout` — four weeks in milliseconds
 * is past 2^31-1, where a delay fires immediately instead of never.
 *
 * Harness trimmed from messaging.timer.test.ts: the same mocked `./db`,
 * `./ws`, `./api` and `./decoy`. `./db` is mocked outright because every
 * assertion here is about which call was made and when, never about SQL.
 */

jest.mock('../src/ws', () => {
  const state = { open: true };
  class WsClient {
    onFrame() {}
    onState() {}
    start() {}
    stop() {}
    send() {
      return true;
    }
    get isOpen() {
      return state.open;
    }
  }
  return { WsClient };
});

jest.mock('../src/api', () => ({
  apiUploadKeys: jest.fn(),
  apiDeleteAccount: jest.fn(),
  apiGetPrekeyBundle: jest.fn(),
  apiCreateAttachment: jest.fn(),
  apiGetAttachmentUrl: jest.fn(),
  uploadBlob: jest.fn(),
  downloadBlob: jest.fn(),
}));

jest.mock('../src/decoy', () => ({
  syncDecoyProfile: jest.fn(async () => undefined),
}));

jest.mock('../src/db', () => ({
  armExpiry: jest.fn(async () => undefined),
  sweepExpired: jest.fn(async () => 0),
  getChat: jest.fn(async () => null),
  listLinkedDevices: jest.fn(async () => []),
  listPeerDevices: jest.fn(async () => []),
  listBlockedPeers: jest.fn(async () => []),
  listIdentityChanged: jest.fn(async () => []),
  listOutbox: jest.fn(async () => []),
  loadProfile: jest.fn(async () => null),
}));

import { messaging } from '../src/messaging';

type Mocks = Record<string, jest.Mock>;
const db = jest.requireMock('../src/db') as Mocks;

const PEER = '01FRIENDZ3NDEKTSV4RRFFQ69G';

/** Five minutes and four weeks, the two ends of the shipped 1:1 list. */
const FIVE_MINUTES = 5 * 60;
const FOUR_WEEKS = 28 * 24 * 60 * 60;
/** The clamp: no pending re-sweep sleeps longer than a day. */
const A_DAY_MS = 24 * 60 * 60 * 1000;

/** Let the sweep's awaited db calls settle; fake timers do not stop
 * microtasks, so this is turns of the promise queue, not of the clock. */
async function flush(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** Move the clock and let whatever fired finish its awaits. */
async function advance(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await flush();
}

beforeEach(() => {
  messaging.stop();
  jest.useFakeTimers();
  db.getChat!.mockReset().mockResolvedValue(null);
  db.armExpiry!.mockReset().mockResolvedValue(undefined);
  db.sweepExpired!.mockReset().mockResolvedValue(0);
});

afterEach(() => {
  messaging.stop();
  jest.useRealTimers();
});

/** A thread whose agreed timer is `seconds`. */
function threadWithTimer(seconds: number): void {
  db.getChat!.mockResolvedValue({ peerId: PEER, disappearSec: seconds });
}

test('a five-minute thread arms a re-sweep for the moment the rows it just armed come due', async () => {
  threadWithTimer(FIVE_MINUTES);

  await messaging.sweepDisappearing(PEER);
  expect(db.armExpiry).toHaveBeenCalledTimes(1);
  expect(db.sweepExpired).toHaveBeenCalledTimes(1);

  // One millisecond short of the timer: nothing has come due yet.
  await advance(FIVE_MINUTES * 1000 - 1);
  expect(db.sweepExpired).toHaveBeenCalledTimes(1);

  await advance(1);
  expect(db.sweepExpired).toHaveBeenCalledTimes(2);
});

test('the re-sweep sweeps but never re-arms — expiry is still stamped at read time', async () => {
  threadWithTimer(FIVE_MINUTES);

  await messaging.sweepDisappearing(PEER);
  await advance(FIVE_MINUTES * 1000);

  // The second pass took what was due and touched nothing else: a message
  // that arrived while nobody was looking must still start its clock when
  // it is READ, which is the whole point of arming on open.
  expect(db.sweepExpired).toHaveBeenCalledTimes(2);
  expect(db.armExpiry).toHaveBeenCalledTimes(1);
});

test('it is single-shot, not a heartbeat — one arm, one fire', async () => {
  threadWithTimer(FIVE_MINUTES);

  await messaging.sweepDisappearing(PEER);
  await advance(FIVE_MINUTES * 1000 * 4);

  expect(db.sweepExpired).toHaveBeenCalledTimes(2);
});

test('a second sweep replaces the pending one instead of stacking a second wake', async () => {
  threadWithTimer(FIVE_MINUTES);

  await messaging.sweepDisappearing(PEER);
  await messaging.sweepDisappearing(PEER);
  expect(db.sweepExpired).toHaveBeenCalledTimes(2);

  await advance(FIVE_MINUTES * 1000);
  expect(db.sweepExpired).toHaveBeenCalledTimes(3);
});

test('a timer that is off arms nothing at all', async () => {
  threadWithTimer(0);

  await messaging.sweepDisappearing(PEER);
  expect(db.sweepExpired).toHaveBeenCalledTimes(1);

  await advance(A_DAY_MS * 2);
  expect(db.sweepExpired).toHaveBeenCalledTimes(1);
});

test('the foreground sweep — no thread, no timer to read — arms nothing either', async () => {
  await messaging.sweepDisappearing();
  expect(db.sweepExpired).toHaveBeenCalledTimes(1);

  await advance(A_DAY_MS * 2);
  expect(db.sweepExpired).toHaveBeenCalledTimes(1);
});

test('four weeks is clamped to a day, because a delay past 2^31-1 fires immediately', async () => {
  threadWithTimer(FOUR_WEEKS);

  await messaging.sweepDisappearing(PEER);
  expect(db.sweepExpired).toHaveBeenCalledTimes(1);

  // THE FALSIFIER for the clamp: an unclamped four weeks is 2,419,200,000 ms.
  // `setTimeout` truncates that to a 32-bit delay and fires on the next tick,
  // so an unclamped build sweeps here, one millisecond in.
  await advance(1);
  expect(db.sweepExpired).toHaveBeenCalledTimes(1);

  await advance(A_DAY_MS);
  expect(db.sweepExpired).toHaveBeenCalledTimes(2);
});

test('stop() takes the pending re-sweep with it — no wake outlives the session', async () => {
  threadWithTimer(FIVE_MINUTES);

  await messaging.sweepDisappearing(PEER);
  messaging.stop();

  await advance(FIVE_MINUTES * 1000 * 2);
  expect(db.sweepExpired).toHaveBeenCalledTimes(1);
});

/**
 * SOONEST WINS.
 *
 * One handle, many threads. A person opens a five-minute thread and then a
 * four-week one; the second pass must not throw away the first pass's wake,
 * because the rows it protects come due in five minutes and the ones the
 * second pass stamped come due in four weeks. Nor may a foreground pass —
 * which reads no thread and so has no timer of its own — cancel a wake that
 * is already pending.
 *
 * `setTimeout` does not report its own deadline, so the due moment is kept
 * beside the handle and a wake is replaced only by a SOONER one.
 */
test('a later, longer thread does not push out the short thread’s wake', async () => {
  threadWithTimer(FIVE_MINUTES);
  await messaging.sweepDisappearing(PEER);

  threadWithTimer(FOUR_WEEKS);
  await messaging.sweepDisappearing(PEER);
  expect(db.sweepExpired).toHaveBeenCalledTimes(2);

  // The four-week pass clamps to a day. If it had replaced the pending wake,
  // nothing would run here and the five-minute rows would sit until the next
  // time somebody happened to look — the exact claim the option must not make.
  await advance(FIVE_MINUTES * 1000);
  expect(db.sweepExpired).toHaveBeenCalledTimes(3);
});

test('a foreground pass leaves a pending wake alone instead of cancelling it', async () => {
  threadWithTimer(FIVE_MINUTES);
  await messaging.sweepDisappearing(PEER);

  // Backgrounded and brought forward again a second later: no peer, so
  // nothing is armed and nothing may be cancelled either.
  await advance(1000);
  await messaging.sweepDisappearing();
  expect(db.sweepExpired).toHaveBeenCalledTimes(2);

  await advance(FIVE_MINUTES * 1000 - 1000);
  expect(db.sweepExpired).toHaveBeenCalledTimes(3);
});
