/**
 * The bridge stays numeric so older native binaries and generated bindings do
 * not need a new shape. `-1` means that native has no packet measurement; the
 * only values that may be presented as bars are the measured levels 1–3.
 */
export const UNKNOWN_CALL_QUALITY = -1 as const;

export type MeasuredCallQuality = 1 | 2 | 3;
export type CallQuality = typeof UNKNOWN_CALL_QUALITY | MeasuredCallQuality;
export type CallQualityStatus = 'checking' | 'measured' | 'unavailable';

/** Reject bridge drift and malformed runtime values instead of turning them
 * into a plausible-looking connection claim. */
export function measuredCallQuality(value: unknown): MeasuredCallQuality | null {
  return value === 1 || value === 2 || value === 3 ? value : null;
}
