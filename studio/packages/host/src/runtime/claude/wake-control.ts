import type { Id, Session } from "@amo-studio/protocol";
import type { ClaudeCore } from "./core.js";
import type { Live } from "./live.js";
import { firstLine } from "./tool-use.js";
import { loopFromScheduleWakeup, studioWakeDue, WAKE_MIN_GAP_MS } from "./wake.js";

// The agent's /loop and usage limits (stage 15; stage 16 split out of claude-runtime.ts): the session's wake as the
// turns set it, and Studio's own timer that goes on when the CLI has not (see wake.ts).

export class ClaudeWake {
  /** Studio's own timer per session with a wake: it goes on when the CLI has not. */
  private readonly timers = new Map<Id, ReturnType<typeof setTimeout>>();
  /** The Host is closing: no new timers. */
  private shuttingDown = false;
  /** The person's 「恢复后自动继续」 per session, kept for the next usage limit too. */
  private readonly autoContinueChoice = new Map<Id, boolean>();
  /** When Studio last started a turn itself, per session (its next one waits WAKE_MIN_GAP_MS). */
  private readonly lastStudioWake = new Map<Id, number>();

  constructor(
    private readonly core: ClaudeCore,
    /** The latest reset among the session's quota windows known to be used up (ms), if any. */
    private readonly usedUpUntil: (sessionId: Id) => number | null,
  ) {}

  onScheduleWakeup(sessionId: Id, live: Live, input: Record<string, unknown>, result: unknown): void {
    live.scheduled = true;
    if (live.stopLoopAtEnd) return;
    const next = loopFromScheduleWakeup(input, result, this.core.now());
    const wake = this.core.store.getSession(sessionId)?.wake ?? {};
    const { loop: _old, ...rest } = wake;
    this.set(sessionId, next.stop ? rest : { ...rest, loop: next.loop });
  }

  /** At the end of a turn: a usage limit to wait for, or a loop that has ended (its wakeup fired and was not renewed). */
  afterTurn(sessionId: Id, live: Live): void {
    const wake = this.core.store.getSession(sessionId)?.wake ?? null;
    const now = this.core.now();
    if (live.stopLoopAtEnd) {
      this.set(sessionId, null);
    } else if (live.limitText !== null) {
      const resetsAt = this.limitResetsAt(sessionId, live);
      // In a loop Studio goes on after the reset by default; otherwise as the person last chose for this session.
      const autoContinue = this.autoContinueChoice.get(sessionId) ?? !!wake?.loop;
      this.set(sessionId, { ...(wake?.loop ? { loop: wake.loop } : {}), limit: { resetsAt, message: live.limitText, autoContinue } });
      this.core.log(`usage limit in ${sessionId}: resets ${resetsAt ?? "(unknown)"}, Studio continues: ${autoContinue}`);
    } else {
      if (live.afterLimit) this.core.log(`${sessionId} went on after its usage limit (turn started by ${live.afterLimit})`);
      if (wake?.loop && !live.scheduled && Date.parse(wake.loop.at) <= now.getTime()) {
        const { loop: _done, ...rest } = wake;
        this.set(sessionId, rest);
      }
    }
    live.limitText = null;
    live.scheduled = false;
    live.afterLimit = null;
    live.refused = null;
  }

  /** When the usage limit that stopped this turn resets: from the refusal, else a quota window known to be used up. */
  private limitResetsAt(sessionId: Id, live: Live): string | null {
    if (live.refused?.resetsAt) return new Date(live.refused.resetsAt * 1000).toISOString();
    const until = this.usedUpUntil(sessionId);
    return until === null ? null : new Date(until).toISOString();
  }

  /** A turn starts: a usage limit it was waiting for is over (whoever started it: the CLI, Studio or the person). */
  onTurnStart(sessionId: Id, live: Live, by: "cli" | "person"): void {
    const wake = this.core.store.getSession(sessionId)?.wake;
    live.afterLimit = wake?.limit ? (by === "person" && live.sendingForStudio ? "studio" : by) : null;
    live.sendingForStudio = false;
    if (wake?.limit) {
      const { limit: _over, ...rest } = wake;
      this.set(sessionId, rest);
    }
  }

  private set(sessionId: Id, wake: Session["wake"]): void {
    const session = this.core.store.getSession(sessionId);
    if (!session) return;
    const next = wake && (wake.loop || wake.limit) ? wake : null;
    if (JSON.stringify(session.wake ?? null) !== JSON.stringify(next)) this.core.updateSession(sessionId, { wake: next });
    this.arm(sessionId);
  }

  /** Studio's own timer for the session's wake (see studioWakeDue): replaced on every change. */
  arm(sessionId: Id): void {
    const old = this.timers.get(sessionId);
    if (old) clearTimeout(old);
    this.timers.delete(sessionId);
    const session = this.core.store.getSession(sessionId);
    if (!session || session.archivedAt || this.shuttingDown) return;
    const due = this.due(session);
    if (!due) return;
    // setTimeout holds at most ~24.8 days; a later time is checked again then.
    const delay = Math.min(Math.max(0, due.at - this.core.now().getTime()), 2 ** 31 - 1);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      void this.fire(sessionId, due.at);
    }, delay);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  /** studioWakeDue, never sooner than WAKE_MIN_GAP_MS after Studio's last one (a reset time that is off cannot make it spin). */
  private due(session: Session): ReturnType<typeof studioWakeDue> {
    const due = studioWakeDue(session.wake, this.core.live.has(session.id), this.core.now());
    const last = this.lastStudioWake.get(session.id);
    return due && last !== undefined ? { ...due, at: Math.max(due.at, last + WAKE_MIN_GAP_MS) } : due;
  }

  /** Studio starts the session's next turn itself: the CLI did not (or its process is gone). */
  private async fire(sessionId: Id, plannedAt: number): Promise<void> {
    const session = this.core.store.getSession(sessionId);
    if (!session || session.archivedAt || session.writer !== "workbench") return;
    const due = this.due(session);
    // Changed since (a turn ran, the person stepped in) or not yet: armed again for what holds now.
    if (!due || due.at !== plannedAt) return this.arm(sessionId);
    if (due.at > this.core.now().getTime()) return this.arm(sessionId);
    // Busy: the turn's end arms the timer again.
    if (this.core.live.get(sessionId)?.running) return;
    this.core.log(`Studio wakes ${sessionId} (${due.why})`);
    this.lastStudioWake.set(sessionId, this.core.now().getTime());
    if (due.why === "loop") {
      // The wakeup Studio sends replaces the CLI's (gone with its process, or late): the loop's next ScheduleWakeup sets it again.
      const { loop: _sent, ...rest } = session.wake ?? {};
      this.core.updateSession(sessionId, { wake: rest.limit ? rest : null });
    }
    try {
      await this.core.closing.get(sessionId);
      const live = this.core.ensureLive(this.core.requireSession(sessionId));
      live.sendingForStudio = true;
      await this.core.sendMessage(sessionId, due.text);
    } catch (err) {
      this.core.log(`Studio could not wake ${sessionId}: ${firstLine(err)}`);
      this.core.appendItem(sessionId, { type: "notice", level: "warning", message: `Studio 没能自动继续这条会话：${firstLine(err)}` });
    }
  }

  /** The person: stop the loop (and Studio's own continuation), or switch auto-continue after a usage limit. */
  async setChoice(sessionId: Id, choice: { stopLoop?: boolean; autoContinue?: boolean }): Promise<Session> {
    const session = this.core.requireSession(sessionId);
    if (choice.stopLoop) {
      const live = this.core.live.get(sessionId);
      this.set(sessionId, null);
      // The CLI's own wakeup lives in its process: it goes with it (now, or when the running turn ends).
      if (live?.running) live.stopLoopAtEnd = true;
      else if (live) await this.core.close(sessionId);
      this.core.appendItem(sessionId, { type: "notice", level: "info", message: "你在 Studio 里停止了这条会话的 loop。" });
    } else if (typeof choice.autoContinue === "boolean") {
      this.autoContinueChoice.set(sessionId, choice.autoContinue);
      if (session.wake?.limit) this.set(sessionId, { ...session.wake, limit: { ...session.wake.limit, autoContinue: choice.autoContinue } });
    }
    return this.core.requireSession(sessionId);
  }

  /** Host shutdown: no timers left behind, none armed after. */
  shutdown(): void {
    this.shuttingDown = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
