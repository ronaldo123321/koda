import type { EventSink } from "@koda/agent-core";
import type { AgentEvent } from "@koda/protocol";

export interface TextWriter {
  write(text: string): unknown;
}

export interface ConsoleEventSinkOptions {
  stdout: TextWriter;
  stderr: TextWriter;
}

export class ConsoleEventSink implements EventSink {
  private answerEndsWithNewline = true;

  public constructor(private readonly options: ConsoleEventSinkOptions) {}

  public async append(event: AgentEvent): Promise<void> {
    if (event.type === "turn.started") {
      this.writeDiagnostic(`thread ${event.threadId}`);
      return;
    }

    if (event.type === "assistant.delta") {
      this.options.stdout.write(event.payload.text);
      this.answerEndsWithNewline = event.payload.text.endsWith("\n");
      return;
    }

    if (event.type === "tool.started") {
      this.writeDiagnostic(`using ${event.payload.name}`);
      return;
    }

    if (event.type === "artifact.recorded") {
      this.writeDiagnostic(
        `artifact ${event.payload.artifact.id} (${event.payload.artifact.bytes} bytes)`,
      );
      return;
    }

    if (
      event.type === "item.recorded" &&
      event.payload.item.type === "recovery"
    ) {
      if (event.payload.item.unavailableArtifacts.length > 0) {
        this.writeDiagnostic(
          `unavailable artifacts: ${event.payload.item.unavailableArtifacts.map((artifact) => `${artifact.id} (${artifact.reason})`).join(", ")}`,
        );
      }
      if (event.payload.item.instructionChanges.length > 0) {
        this.writeDiagnostic(
          `repository instructions changed: ${event.payload.item.instructionChanges.map((change) => `${change.change} ${change.path}`).join(", ")}`,
        );
      }
      if (event.payload.item.uncertainToolCalls.length > 0) {
        this.writeDiagnostic(
          `uncertain operations: ${event.payload.item.uncertainToolCalls.map((call) => `${call.name} (${call.callId}${call.effect === undefined ? "" : `, ${call.effect}`}${call.process === undefined ? "" : `, process ${call.process.pid} ${call.process.status}`})`).join(", ")}`,
        );
      }
      return;
    }

    if (
      event.type === "item.recorded" &&
      event.payload.item.type === "compaction"
    ) {
      const before = event.payload.item.estimatedTokensBefore;
      const after = event.payload.item.estimatedTokensAfter;
      this.writeDiagnostic(
        before === undefined || after === undefined
          ? "context compacted"
          : `context compacted: approximately ${before} -> ${after} input tokens`,
      );
      return;
    }

    if (event.type === "tool.completed") {
      this.writeDiagnostic(
        `${event.payload.name} ${event.payload.status === "success" ? "completed" : "failed"}`,
      );
      return;
    }

    if (event.type === "process.termination_requested") {
      this.writeDiagnostic(
        `terminating process ${event.payload.pid}: ${event.payload.reason} (${event.payload.attempt})`,
      );
      return;
    }

    if (event.type === "process.termination_completed") {
      this.writeDiagnostic(
        `process ${event.payload.pid} termination ${event.payload.outcome}`,
      );
      return;
    }

    if (event.type === "turn.failed") {
      this.writeDiagnostic(`${event.payload.code}: ${event.payload.message}`);
      this.writeUsage(event.payload.usage);
      return;
    }

    if (event.type === "turn.cancelled") {
      this.writeDiagnostic(event.payload.reason);
      this.writeUsage(event.payload.usage);
      return;
    }

    if (event.type === "turn.completed") {
      if (!this.answerEndsWithNewline) {
        this.options.stdout.write("\n");
        this.answerEndsWithNewline = true;
      }
      this.writeUsage(event.payload.usage);
    }
  }

  private writeDiagnostic(message: string): void {
    this.options.stderr.write(`[koda] ${message}\n`);
  }

  private writeUsage(
    usage:
      | Extract<AgentEvent, { type: "turn.completed" }>["payload"]["usage"]
      | undefined,
  ): void {
    if (usage === undefined) {
      return;
    }
    if (usage.reportedRequests === 0) {
      this.writeDiagnostic(
        `token usage unavailable; 0/${usage.modelRequests} requests reported`,
      );
      return;
    }
    const tokens = usage.tokens;
    this.writeDiagnostic(
      `tokens: ${tokens.inputTokens} input (${tokens.cachedInputTokens} cached, ${tokens.cacheWriteInputTokens} cache write), ${tokens.outputTokens} output (${tokens.reasoningOutputTokens} reasoning), ${tokens.totalTokens} total; ${usage.reportedRequests}/${usage.modelRequests} requests reported`,
    );
  }
}
