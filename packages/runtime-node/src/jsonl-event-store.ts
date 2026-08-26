import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { EventReader, EventReadResult, EventSink } from "@koda/agent-core";
import { agentEventSchema, type AgentEvent } from "@koda/protocol";

export class EventLogCorruptionError extends Error {
  public constructor(
    message: string,
    public readonly line: number,
  ) {
    super(message);
    this.name = "EventLogCorruptionError";
  }
}

export class JsonlEventStore implements EventSink, EventReader {
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async append(event: AgentEvent): Promise<void> {
    const validated = agentEventSchema.parse(event);
    const line = `${JSON.stringify(validated)}\n`;

    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, line, "utf8");
    });
    await this.writeChain;
  }

  public async readAll(): Promise<EventReadResult> {
    await this.writeChain;
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { events: [], diagnostics: [] };
      }
      throw error;
    }

    if (content.length === 0) {
      return { events: [], diagnostics: [] };
    }

    const hasTrailingNewline = content.endsWith("\n");
    const lines = content.split("\n");
    if (hasTrailingNewline) {
      lines.pop();
    }

    const events: AgentEvent[] = [];
    const diagnostics: EventReadResult["diagnostics"] = [];

    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1;
      if (line.length === 0) {
        throw new EventLogCorruptionError(
          `Event log contains an empty line at line ${lineNumber}.`,
          lineNumber,
        );
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(line);
      } catch (error) {
        const isPartialTail = index === lines.length - 1 && !hasTrailingNewline;
        if (isPartialTail) {
          diagnostics.push({
            code: "PARTIAL_TRAILING_LINE",
            message: `Ignored a partial trailing event at line ${lineNumber}.`,
            line: lineNumber,
          });
          break;
        }
        throw new EventLogCorruptionError(
          `Event log contains invalid JSON at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
          lineNumber,
        );
      }

      const parsedEvent = agentEventSchema.safeParse(parsedJson);
      if (!parsedEvent.success) {
        const isPartialTail = index === lines.length - 1 && !hasTrailingNewline;
        if (isPartialTail) {
          diagnostics.push({
            code: "PARTIAL_TRAILING_LINE",
            message: `Ignored a partial trailing event at line ${lineNumber}.`,
            line: lineNumber,
          });
          break;
        }
        throw new EventLogCorruptionError(
          `Event log contains an invalid event at line ${lineNumber}: ${parsedEvent.error.message}`,
          lineNumber,
        );
      }

      const previous = events.at(-1);
      if (previous === undefined && parsedEvent.data.sequence !== 0) {
        throw new EventLogCorruptionError(
          "Event sequence must begin at zero.",
          lineNumber,
        );
      }
      if (
        previous !== undefined &&
        parsedEvent.data.sequence !== previous.sequence + 1
      ) {
        throw new EventLogCorruptionError(
          `Event sequence is not contiguous at line ${lineNumber}.`,
          lineNumber,
        );
      }
      events.push(parsedEvent.data);
    }

    return { events, diagnostics };
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
