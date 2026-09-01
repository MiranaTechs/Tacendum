import { CallMetricReport, type CallEndReason } from '@tacendum/shared';
import {
  discardCallMetricReport,
  deleteCallMetricReport,
  finalizeCallMetricReport,
  listDueCallMetricReports,
  nextCallMetricAttemptAt,
  markCallMetricAnswered,
  markCallMetricConnected,
  openCallMetricReport,
  pruneExpiredCallMetricReports,
  raiseCallMetricPeak,
  reconcileCallMetricReports,
  recordCallMetricRetry,
  touchCallMetricReport,
  type QueuedCallMetricReport,
} from '../db';
import { activeWorkspace } from '../db';
import { apiPostCallMetric } from '../api';
import { currentToken } from '../reauth';
import { session } from '../session';
import type { CallMetricSink } from './service';

const HEARTBEAT_MS = 30_000;
const REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CallMetricLifecycleDeps {
  open: typeof openCallMetricReport;
  answered: typeof markCallMetricAnswered;
  connected: typeof markCallMetricConnected;
  peak: typeof raiseCallMetricPeak;
  finalize: typeof finalizeCallMetricReport;
  discard: typeof discardCallMetricReport;
  touch: typeof touchCallMetricReport;
  now(): number;
}

/**
 * The one local metric writer shared by 1:1 calls and starter-owned sessions.
 * It intentionally only persists lifecycle work; Task 6 owns network draining.
 */
export class CallMetricLifecycle implements CallMetricSink {
  private generation = 0;
  private readonly active = new Set<string>();
  private readonly queued = new Set<() => void>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: CallMetricLifecycleDeps = {
    open: openCallMetricReport,
    answered: markCallMetricAnswered,
    connected: markCallMetricConnected,
    peak: raiseCallMetricPeak,
    finalize: finalizeCallMetricReport,
    discard: discardCallMetricReport,
    touch: touchCallMetricReport,
    now: () => Date.now(),
  }) {}

  onQueued(listener: () => void): () => void {
    this.queued.add(listener);
    return () => this.queued.delete(listener);
  }

  deactivate(localId?: string): void {
    if (localId === undefined) {
      // Full deactivation is a workspace ownership boundary. Any write that
      // was already awaiting SQLite may finish, but its continuation must not
      // re-arm a heartbeat or wake the replacement workspace.
      this.generation++;
      this.active.clear();
    } else {
      this.active.delete(localId);
    }
    this.stopHeartbeatIfIdle();
  }

  async open(input: Parameters<CallMetricSink['open']>[0]): Promise<void> {
    const generation = this.generation;
    const opened = await this.write(() =>
      this.deps.open({ ...input, expiresAt: input.startedAt + REPORT_TTL_MS }),
    );
    if (!opened || generation !== this.generation) return;
    this.active.add(input.localId);
    this.startHeartbeat();
  }

  async answered(localId: string, at: number): Promise<void> {
    await this.write(() => this.deps.answered(localId, at));
  }

  async connected(localId: string, at: number): Promise<void> {
    await this.write(() => this.deps.connected(localId, at));
  }

  async peak(localId: string, participants: number): Promise<void> {
    await this.write(() => this.deps.peak(localId, participants));
  }

  async finalize(localId: string, reason: CallEndReason, endedAt: number): Promise<void> {
    const generation = this.generation;
    const finalized = await this.write(() =>
      this.deps.finalize({ localId, reason, endedAt }),
    );
    if (generation !== this.generation) return;
    this.deactivate(localId);
    if (finalized) this.notifyQueued();
  }

  async discard(localId: string): Promise<void> {
    const generation = this.generation;
    await this.write(() => this.deps.discard(localId));
    if (generation === this.generation) this.deactivate(localId);
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== null) return;
    this.heartbeat = setInterval(() => {
      for (const localId of this.active) {
        void this.write(() => this.deps.touch(localId, this.deps.now()));
      }
    }, HEARTBEAT_MS);
    // A heartbeat is not authority to keep a quiescing JS runtime alive.
    // Native timers do not expose this method; Node test/runtime timers do.
    (this.heartbeat as unknown as { unref?: () => void }).unref?.();
  }

  private stopHeartbeatIfIdle(): void {
    if (this.active.size !== 0 || this.heartbeat === null) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private async write(operation: () => Promise<void>): Promise<boolean> {
    try {
      await operation();
      return true;
    } catch (error) {
      // Do not include local identifiers, SDP, or payload data in diagnostics.
      console.warn(`[call-metrics] write failed: ${error instanceof Error ? error.name : 'unknown'}`);
      return false;
    }
  }

  private notifyQueued(): void {
    for (const listener of this.queued) {
      try {
        listener();
      } catch (error) {
        console.warn(`[call-metrics] queue listener failed: ${error instanceof Error ? error.name : 'unknown'}`);
      }
    }
  }
}

export const callMetricLifecycle = new CallMetricLifecycle();

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60 * 60 * 1_000;
const POISON_STATUSES = new Set([400, 403, 404, 409, 422]);

/** Dependencies stay injectable so the queue's locking and time boundaries are testable. */
export interface CallMetricDrainDeps {
  reconcile(): Promise<void>;
  prune(now: number): Promise<void>;
  listDue(now: number, limit: number): Promise<QueuedCallMetricReport[]>;
  nextDueAt(after: number): Promise<number | null>;
  retry(reportId: string, attempts: number, nextAttemptAt: number): Promise<void>;
  remove(reportId: string): Promise<void>;
  token(): Promise<string | null>;
  post(token: string, body: CallMetricReport): Promise<{ status: number; retryAfterSeconds: number | null }>;
  isReal(): boolean;
  now(): number;
  random(): number;
  setTimer(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
  warn(message: string): void;
}

/**
 * A single-flight durable uploader. Its generation is the boundary between
 * workspaces: no continuation may update a row after deactivation, even if a
 * replacement real workspace has opened by the time its request resolves.
 */
export class CallMetricDrain {
  private generation = 0;
  private active = false;
  private inFlight: Promise<void> | null = null;
  private rerun = false;
  private dueTimer: ReturnType<typeof setTimeout> | null = null;
  private dueAt: number | null = null;

  constructor(private readonly deps: CallMetricDrainDeps) {}

  get activeReal(): boolean {
    return this.active;
  }

  async activate(onActivated?: () => void): Promise<void> {
    this.deactivate();
    if (!this.deps.isReal()) return;
    this.active = true;
    const generation = this.generation;
    // The generation is authoritative before recovery starts. Let callback
    // owners capture it now: a finalization during reconcile/prune/listDue
    // must latch a follow-up pass rather than disappear behind that snapshot.
    onActivated?.();
    // A previous workspace can still be unwinding a fetch. Wait for its
    // invalidated pass, then explicitly launch THIS generation's recovery;
    // returning that old promise would silently lose reconcile/prune/drain.
    while (this.valid(generation)) {
      if (this.inFlight !== null) {
        await this.inFlight;
        continue;
      }
      await this.kick(true, generation);
      return;
    }
  }

  deactivate(): void {
    this.generation++;
    this.active = false;
    this.rerun = false;
    if (this.dueTimer !== null) {
      this.deps.clearTimer(this.dueTimer);
      this.dueTimer = null;
      this.dueAt = null;
    }
  }

  /** Bind an external callback to the real workspace that registered it. */
  captureNudge(): () => void {
    const generation = this.generation;
    return () => {
      void this.nudge(generation);
    };
  }

  async nudge(generation = this.generation): Promise<void> {
    if (!this.valid(generation)) return;
    await this.kick(false, generation);
  }

  private valid(generation: number): boolean {
    return this.active && generation === this.generation && this.deps.isReal();
  }

  private async kick(recover: boolean, generation: number): Promise<void> {
    if (!this.valid(generation)) return;
    if (this.inFlight !== null) {
      this.rerun = true;
      return this.inFlight;
    }
    const work = this.run(generation, recover);
    this.inFlight = work;
    try {
      await work;
    } finally {
      if (this.inFlight === work) this.inFlight = null;
    }
  }

  private async run(generation: number, recover: boolean): Promise<void> {
    let needsRecovery = recover;
    do {
      this.rerun = false;
      try {
        if (needsRecovery) {
          await this.deps.reconcile();
          if (!this.valid(generation)) return;
          needsRecovery = false;
        }
        // Retention is a drain invariant, not merely a boot task. A process
        // can stay alive past an outbox row's seven-day boundary.
        await this.deps.prune(this.deps.now());
        if (!this.valid(generation)) return;
        const fullBatch = await this.drainDue(generation);
        // SQLite gives us a bounded oldest-first page. A full page is proof
        // there may be more due now, so consume another bounded page without
        // waiting for an unrelated foreground/auth/transport wakeup.
        if (fullBatch && this.valid(generation)) this.rerun = true;
        if (!fullBatch && this.valid(generation)) {
          await this.syncPersistedTimer(generation);
        }
      } catch (error) {
        // The uploader is intentionally invisible to calls and app lifecycle.
        this.deps.warn(`[call-metrics] drain failed: ${error instanceof Error ? error.name : 'unknown'}`);
      }
    } while (this.rerun && this.valid(generation));
  }

  private async drainDue(generation: number): Promise<boolean> {
    const reports = await this.deps.listDue(this.deps.now(), 20);
    if (!this.valid(generation)) return false;
    for (const report of reports.slice(0, 20)) {
      if (!this.valid(generation)) return false;
      const token = await this.deps.token();
      if (!this.valid(generation)) return false;
      if (!token) return false;
      let body: CallMetricReport;
      try {
        body = CallMetricReport.parse(JSON.parse(report.payload));
      } catch {
        this.deps.warn('[call-metrics] queued report could not be decoded');
        // The terminal payload is immutable. Retrying the same invalid bytes
        // can never heal them, so this is local structural poison.
        await this.deps.remove(report.reportId);
        if (!this.valid(generation)) return false;
        continue;
      }
      let response: { status: number; retryAfterSeconds: number | null };
      try {
        response = await this.deps.post(token, body);
      } catch {
        await this.scheduleRetry(report, null, generation);
        continue;
      }
      if (!this.valid(generation)) return false;
      if (response.status === 204) {
        await this.deps.remove(report.reportId);
        if (!this.valid(generation)) return false;
      } else if (POISON_STATUSES.has(response.status)) {
        this.deps.warn(`[call-metrics] discarded structurally refused report (${response.status})`);
        await this.deps.remove(report.reportId);
        if (!this.valid(generation)) return false;
      } else {
        await this.scheduleRetry(report, response.retryAfterSeconds, generation);
      }
    }
    return reports.length === 20;
  }

  private async scheduleRetry(
    report: QueuedCallMetricReport,
    retryAfterSeconds: number | null,
    generation: number,
  ): Promise<void> {
    if (!this.valid(generation)) return;
    const attempts = report.attempts + 1;
    const delay = Number.isInteger(retryAfterSeconds) && retryAfterSeconds! >= 0
      ? retryAfterSeconds! * 1_000
      : this.backoff(attempts);
    const nextAttemptAt = this.deps.now() + delay;
    await this.deps.retry(report.reportId, attempts, nextAttemptAt);
    if (!this.valid(generation)) return;
    this.arm(nextAttemptAt, generation);
  }

  private backoff(attempts: number): number {
    const base = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, attempts - 1));
    const random = Math.max(0, Math.min(1, this.deps.random()));
    return Math.max(RETRY_MIN_MS, Math.min(RETRY_MAX_MS, Math.round(base * (0.5 + random))));
  }

  private async syncPersistedTimer(generation: number): Promise<void> {
    const now = this.deps.now();
    const dueAt = await this.deps.nextDueAt(now);
    if (!this.valid(generation)) return;
    if (dueAt === null) {
      if (this.dueTimer !== null) this.deps.clearTimer(this.dueTimer);
      this.dueTimer = null;
      this.dueAt = null;
      return;
    }
    this.arm(dueAt, generation);
  }

  private arm(dueAt: number, generation: number): void {
    // One timer represents the next pending retry, never merely the row most
    // recently examined. Replacing an earlier timer strands that report.
    if (this.dueAt !== null && this.dueAt <= dueAt) return;
    if (this.dueTimer !== null) this.deps.clearTimer(this.dueTimer);
    const delay = Math.max(0, dueAt - this.deps.now());
    this.dueTimer = this.deps.setTimer(() => {
      this.dueTimer = null;
      this.dueAt = null;
      if (this.valid(generation)) void this.nudge();
    }, delay);
    this.dueAt = dueAt;
    (this.dueTimer as unknown as { unref?: () => void }).unref?.();
  }
}

export const callMetricDrain = new CallMetricDrain({
  reconcile: reconcileCallMetricReports,
  prune: pruneExpiredCallMetricReports,
  listDue: listDueCallMetricReports,
  nextDueAt: nextCallMetricAttemptAt,
  retry: recordCallMetricRetry,
  remove: deleteCallMetricReport,
  token: currentToken,
  post: apiPostCallMetric,
  isReal: () => session.mode === 'real' && activeWorkspace() === 'real',
  now: () => Date.now(),
  random: () => Math.random(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: timer => clearTimeout(timer),
  warn: message => console.warn(message),
});

export function activateCallMetricDrain(): Promise<void> {
  return callMetricDrain.activate();
}

export function deactivateCallMetricDrain(): void {
  callMetricDrain.deactivate();
}

export function nudgeCallMetricDrain(): void {
  void callMetricDrain.nudge();
}
