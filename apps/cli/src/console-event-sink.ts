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
    if (event.type === "assistant.delta") {
      this.options.stdout.write(event.payload.text);
      this.answerEndsWithNewline = event.payload.text.endsWith("\n");
      return;
    }

    if (event.type === "tool.started") {
      this.writeDiagnostic(`using ${event.payload.name}`);
      return;
    }

    if (event.type === "tool.completed") {
      this.writeDiagnostic(
        `${event.payload.name} ${event.payload.status === "success" ? "completed" : "failed"}`,
      );
      return;
    }

    if (event.type === "turn.failed") {
      this.writeDiagnostic(`${event.payload.code}: ${event.payload.message}`);
      return;
    }

    if (event.type === "turn.cancelled") {
      this.writeDiagnostic(event.payload.reason);
      return;
    }

    if (event.type === "turn.completed" && !this.answerEndsWithNewline) {
      this.options.stdout.write("\n");
      this.answerEndsWithNewline = true;
    }
  }

  private writeDiagnostic(message: string): void {
    this.options.stderr.write(`[koda] ${message}\n`);
  }
}
