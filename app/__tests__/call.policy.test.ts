import { decidePressure, decideRing, relayForPeer } from '../src/call/policy';

/**
 * Who may ring this phone, and which calls go through the relay (V7).
 *
 * Both defaults here are deliberate departures from what a phone normally
 * does, so the tests state the reasoning rather than just the outcome — a
 * future reader deciding to "fix" either default should have to argue with it.
 */

describe('silence unknown callers', () => {
  it('is ON by default, so a stranger cannot ring a phone at 3am', () => {
    // A ringing phone is an interrupt anyone holding your identifier can
    // trigger, at any hour, as often as they like.
    expect(decideRing({ silenceUnknownCallers: true, hasHistory: false, blocked: false })).toEqual({
      ring: false,
      reason: 'unknown_caller',
    });
  });

  it('lets anyone you have talked to through', () => {
    expect(decideRing({ silenceUnknownCallers: true, hasHistory: true, blocked: false }).ring).toBe(
      true,
    );
  });

  it('can be turned off, and then a stranger does ring', () => {
    // The setting has to actually do something in both directions, or it is
    // decoration.
    expect(
      decideRing({ silenceUnknownCallers: false, hasHistory: false, blocked: false }).ring,
    ).toBe(true);
  });

  it('never lets a blocked peer ring, setting or no setting', () => {
    // Blocking is not a preference to be overridden by another preference.
    expect(decideRing({ silenceUnknownCallers: false, hasHistory: true, blocked: true }).ring).toBe(
      false,
    );
  });
});

describe('always relay', () => {
  it('defaults ON for a peer you have never called', () => {
    // The first call is the one where a direct connection would reveal a home
    // IP to someone who has never had it. One relay hop is the cheaper error.
    expect(relayForPeer({ global: false, remembered: null, hasCalledBefore: false })).toBe(true);
  });

  it('defaults OFF once you have called them before', () => {
    expect(relayForPeer({ global: false, remembered: null, hasCalledBefore: true })).toBe(false);
  });

  it('remembers a per-peer choice over the default', () => {
    expect(relayForPeer({ global: false, remembered: false, hasCalledBefore: false })).toBe(false);
    expect(relayForPeer({ global: false, remembered: true, hasCalledBefore: true })).toBe(true);
  });

  it('lets the global switch win over any per-peer memory', () => {
    // Someone who turns always-relay on app-wide has made a decision that a
    // stale per-peer preference must not quietly weaken.
    expect(relayForPeer({ global: true, remembered: false, hasCalledBefore: true })).toBe(true);
  });
});

describe('thermal, battery and low power', () => {
  const base = {
    thermal: 'nominal' as const,
    lowPower: false,
    battery: 0.8,
    video: true,
  };

  it('does nothing to a healthy phone', () => {
    const d = decidePressure(base);
    expect(d).toMatchObject({
      maxLongEdge: null,
      maxFps: null,
      videoAllowed: true,
      notice: null,
      offerVoice: false,
    });
  });

  it('caps to 640×360 @ 24 and says why at .serious', () => {
    const d = decidePressure({ ...base, thermal: 'serious' });
    expect(d.maxLongEdge).toBe(640);
    expect(d.maxFps).toBe(24);
    expect(d.videoAllowed).toBe(true);
    expect(d.notice).toBe('Reduced quality');
  });

  it('stops sending video at .critical', () => {
    // The next step after .critical is a thermal shutdown, which ends the call
    // outright — so pausing video is the option that keeps the conversation.
    const d = decidePressure({ ...base, thermal: 'critical' });
    expect(d.videoAllowed).toBe(false);
    expect(d.notice).toBe('Video paused to cool down');
  });

  it('caps under Low Power Mode, and names the cause', () => {
    // "Low Power Mode" rather than "Reduced quality": the person can act on
    // the first and only feel let down by the second.
    const d = decidePressure({ ...base, lowPower: true });
    expect(d.maxLongEdge).toBe(640);
    expect(d.videoAllowed).toBe(true);
    expect(d.notice).toBe('Low Power Mode');
  });

  it('lets thermal outrank low power, never the other way round', () => {
    const d = decidePressure({ ...base, lowPower: true, thermal: 'critical' });
    expect(d.videoAllowed).toBe(false);
    expect(d.notice).toBe('Video paused to cool down');
  });

  it('lifts the Low Power cap when the person taps to restore', () => {
    // The cap honors a request the OWNER made to the OS; the tap is the same
    // owner overriding it for this call, so nothing is left capped or shown.
    const d = decidePressure({ ...base, lowPower: true, restored: true });
    expect(d.maxLongEdge).toBeNull();
    expect(d.maxFps).toBeNull();
    expect(d.notice).toBeNull();
    expect(d.restorable).toBe(false);
  });

  it('offers the restore for Low Power only, never for heat', () => {
    // A tap cannot cool a phone down, so offering one under thermal pressure
    // would be a button that does nothing.
    expect(decidePressure({ ...base, lowPower: true }).restorable).toBe(true);
    expect(decidePressure({ ...base, thermal: 'serious' }).restorable).toBe(false);
    expect(decidePressure({ ...base, thermal: 'critical' }).restorable).toBe(false);
    expect(decidePressure(base).restorable).toBe(false);
  });

  it('keeps thermal caps through a restore tap', () => {
    const serious = decidePressure({ ...base, thermal: 'serious', lowPower: true, restored: true });
    expect(serious.maxLongEdge).toBe(640);
    expect(serious.notice).toBe('Reduced quality');
    expect(serious.restorable).toBe(false);

    const critical = decidePressure({ ...base, thermal: 'critical', restored: true });
    expect(critical.videoAllowed).toBe(false);
  });

  it('offers voice below 10% — and only offers it', () => {
    const d = decidePressure({ ...base, battery: 0.09 });
    expect(d.offerVoice).toBe(true);
    // Nothing is forced: the video keeps flowing until the person taps.
    expect(d.videoAllowed).toBe(true);
    expect(d.maxLongEdge).toBeNull();
    expect(decidePressure({ ...base, battery: 0.1 }).offerVoice).toBe(false);
  });

  it('treats an unknown battery as unknown, not as empty', () => {
    // The Simulator reports -1, which the native side sends as null. Reading
    // that as 0 would offer to drop every Simulator call to voice.
    expect(decidePressure({ ...base, battery: null }).offerVoice).toBe(false);
  });

  it('says nothing at all about a voice call', () => {
    // Telling someone their AUDIO call is "reduced quality" because the phone
    // is warm is alarming and useless — there is no video to reduce.
    for (const thermal of ['serious', 'critical'] as const) {
      const d = decidePressure({ ...base, thermal, video: false, battery: 0.01 });
      expect(d.notice).toBeNull();
      expect(d.videoAllowed).toBe(true);
      expect(d.maxLongEdge).toBeNull();
      expect(d.offerVoice).toBe(false);
    }
  });

  it('lifts the thermal cap when the phone cools, but not the low-power one', () => {
    // A phone cooling down is a fact about the world. Low Power Mode is a
    // request its owner made, and spending their battery back on 720p without
    // being asked contradicts it.
    expect(decidePressure({ ...base, thermal: 'fair' }).maxLongEdge).toBeNull();
    expect(decidePressure({ ...base, thermal: 'fair', lowPower: true }).maxLongEdge).toBe(640);
  });
});
