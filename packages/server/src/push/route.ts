import type { PushSender } from '../handlers/http.js';
import type { PushTokenRecord } from '../db/data.js';

/**
 * The ONE place that decides which push network a token row belongs to
 * Everything upstream — wakeRecipient, deliverPushWake —
 * keeps speaking to a single PushSender exactly as before; everything
 * downstream (the APNs and FCM lanes) receives only rows that are its own.
 *
 * The routing fact is the row's `platform` discriminator, and ABSENT MEANS
 * iOS: every row written before this field existed is an APNs row, and the
 * compatibility rule is stated once, on PushTokenRecord, and consumed here.
 * Deliberately NOT inferred from which token fields happen to be present —
 * a row is one platform's row because its registration said so, not because
 * of which of its attributes survived a prune.
 */
export function makePlatformPushSender(lanes: {
  apns: PushSender;
  fcm: PushSender;
}): PushSender {
  const laneFor = (token: PushTokenRecord): PushSender =>
    token.platform === 'android' ? lanes.fcm : lanes.apns;
  return {
    wake: (token, fromUserId) => laneFor(token).wake(token, fromUserId),
    notify: (token, message) => laneFor(token).notify(token, message),
  };
}
