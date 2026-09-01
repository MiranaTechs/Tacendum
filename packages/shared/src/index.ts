export * from './tables.js';
// No phone module: accounts are keypair-only. There
// is no number to normalize, so E.164 canonicalization has no caller left.
export * from './dto.js';
export * from './crew.js';
export * from './frames.js';
export * from './call.js';
export * from './call-machine.js';
// The x.approval wire pair. Through the barrel, on the standing
// precedent: a new shared module is unreachable
// from the app without a re-export line, and this is the one existing shared
// file that line may touch.
export * from './approval-envelope.js';
// The x.edit stream envelope, through the barrel
// on the same rule.
export * from './stream-envelope.js';
// The Art. 50 AI-origin marker and the `msg` bare-text carrier, through the barrel on the same rule.
export * from './ai-origin.js';
// The pairwise consent edge DTO + cap, through the
// barrel on the same rule.
export * from './consent.js';

/**
 * Wire-protocol frame types, REST DTOs, and the message envelope format
 * land here as the system needs them. Kept dependency-free so the
 * React Native app can import the same source of truth.
 */
export const SHARED_PACKAGE = '@tacendum/shared';
