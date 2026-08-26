import { spawn, type ChildProcess } from "node:child_process";

import type { ToolOperationalEvent } from "@koda/agent-core";
import type {
  ProcessOwnership,
  ProcessTerminationOutcome,
  ProcessTerminationReason,
} from "@koda/protocol";

export type ProcessTerminationReport = {
  reason: ProcessTerminationReason;
  outcome: ProcessTerminationOutcome;
};

export interface OwnedProcessTreeOptions {
  child: ChildProcess;
  pid: number;
  terminationGraceMs: number;
  terminationConfirmationMs: number;
  report?: (event: ToolOperationalEvent) => Promise<void>;
  platform?: NodeJS.Platform;
}

export class OwnedProcessTree {
  public readonly ownership: ProcessOwnership;
  private readonly platform: NodeJS.Platform;
  private reportingError: unknown;
  private reportingFailed = false;
  private termination: Promise<ProcessTerminationReport> | undefined;

  public constructor(private readonly options: OwnedProcessTreeOptions) {
    this.platform = options.platform ?? process.platform;
    this.ownership =
      this.platform === "win32"
        ? "windows_taskkill_tree"
        : "posix_process_group";
  }

  public isAlive(): boolean {
    if (this.platform === "win32") {
      return this.isRootAlive();
    }
    try {
      process.kill(-this.options.pid, 0);
      return true;
    } catch (error) {
      return !isNodeError(error, "ESRCH");
    }
  }

  public terminate(
    reason: ProcessTerminationReason,
  ): Promise<ProcessTerminationReport> {
    this.termination ??= this.terminateOnce(reason);
    return this.termination;
  }

  private async terminateOnce(
    reason: ProcessTerminationReason,
  ): Promise<ProcessTerminationReport> {
    if (!this.isAlive()) {
      return this.complete(reason, "already_exited");
    }

    if (this.platform === "win32") {
      return this.terminateWindows(reason);
    }
    return this.terminatePosix(reason);
  }

  private async terminatePosix(
    reason: ProcessTerminationReason,
  ): Promise<ProcessTerminationReport> {
    await this.reportRequested(
      reason,
      "graceful",
      "posix_process_group_signal",
    );
    const term = signalProcessGroup(this.options.pid, "SIGTERM");
    if (term === "already_exited") {
      return this.complete(reason, "already_exited");
    }
    if (
      await waitUntil(() => !this.isAlive(), this.options.terminationGraceMs)
    ) {
      return this.complete(reason, "terminated");
    }

    await this.reportRequested(reason, "force", "posix_process_group_signal");
    const kill = signalProcessGroup(this.options.pid, "SIGKILL");
    if (kill === "already_exited") {
      return this.complete(reason, "terminated");
    }
    const terminated = await waitUntil(
      () => !this.isAlive(),
      this.options.terminationConfirmationMs,
    );
    return this.complete(reason, terminated ? "terminated" : "uncertain");
  }

  private async terminateWindows(
    reason: ProcessTerminationReason,
  ): Promise<ProcessTerminationReport> {
    await this.reportRequested(reason, "graceful", "windows_taskkill");
    const graceful = await runTaskkill(
      this.options.pid,
      false,
      this.options.terminationConfirmationMs,
    );
    if (graceful === "failed") {
      await this.reportRequested(reason, "graceful", "direct_child_signal");
      this.signalChild("SIGTERM");
    }
    if (
      await waitUntil(
        () => !this.isRootAlive(),
        this.options.terminationGraceMs,
      )
    ) {
      return this.complete(
        reason,
        graceful === "already_exited" ? "already_exited" : "terminated",
      );
    }

    await this.reportRequested(reason, "force", "windows_taskkill");
    const forced = await runTaskkill(
      this.options.pid,
      true,
      this.options.terminationConfirmationMs,
    );
    if (forced === "failed") {
      await this.reportRequested(reason, "force", "direct_child_signal");
      this.signalChild("SIGKILL");
    }
    const terminated = await waitUntil(
      () => !this.isRootAlive(),
      this.options.terminationConfirmationMs,
    );
    return this.complete(reason, terminated ? "terminated" : "uncertain");
  }

  private isRootAlive(): boolean {
    return (
      this.options.child.exitCode === null &&
      this.options.child.signalCode === null
    );
  }

  private signalChild(signal: NodeJS.Signals): void {
    try {
      this.options.child.kill(signal);
    } catch {
      // Direct child signaling is only a fallback after tree termination fails.
    }
  }

  private async reportRequested(
    reason: ProcessTerminationReason,
    attempt: "graceful" | "force",
    mechanism:
      "posix_process_group_signal" | "windows_taskkill" | "direct_child_signal",
  ): Promise<void> {
    await this.tryReport({
      type: "process.termination_requested",
      payload: {
        pid: this.options.pid,
        reason,
        attempt,
        mechanism,
      },
    });
  }

  private async complete(
    reason: ProcessTerminationReason,
    outcome: ProcessTerminationOutcome,
  ): Promise<ProcessTerminationReport> {
    await this.tryReport({
      type: "process.termination_completed",
      payload: { pid: this.options.pid, reason, outcome },
    });
    if (this.reportingFailed) {
      throw this.reportingError;
    }
    return { reason, outcome };
  }

  private async tryReport(event: ToolOperationalEvent): Promise<void> {
    try {
      await this.options.report?.(event);
    } catch (error) {
      if (!this.reportingFailed) {
        this.reportingFailed = true;
        this.reportingError = error;
      }
    }
  }
}

function signalProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
): "sent" | "already_exited" | "failed" {
  try {
    process.kill(-pid, signal);
    return "sent";
  } catch (error) {
    return isNodeError(error, "ESRCH") ? "already_exited" : "failed";
  }
}

async function runTaskkill(
  pid: number,
  force: boolean,
  timeoutMs: number,
): Promise<"sent" | "already_exited" | "failed"> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let taskkill: ReturnType<typeof spawn>;
    try {
      taskkill = spawn(
        "taskkill",
        ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
        {
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        },
      );
    } catch {
      resolvePromise("failed");
      return;
    }
    const settle = (result: "sent" | "already_exited" | "failed") => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolvePromise(result);
    };
    taskkill.once("error", () => settle("failed"));
    taskkill.once("close", (code) =>
      settle(code === 0 ? "sent" : code === 128 ? "already_exited" : "failed"),
    );
    timer = setTimeout(
      () => {
        taskkill.kill();
        settle("failed");
      },
      Math.max(100, timeoutMs),
    );
    timer.unref();
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (predicate()) {
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    if (predicate()) {
      return true;
    }
  }
  return predicate();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
