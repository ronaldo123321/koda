import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";

import type { EventReader, EventReadResult, EventSink } from "@koda/agent-core";
import { agentEventSchema, type AgentEvent } from "@koda/protocol";

export interface JsonlEventReadResult extends EventReadResult {
  sourceBytes: number;
  indexedBytes: number;
}

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

  public async readAll(): Promise<JsonlEventReadResult> {
    await this.writeChain;
    let bytes: Buffer;
    try {
      bytes = await readFile(this.filePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {
          events: [],
          diagnostics: [],
          sourceBytes: 0,
          indexedBytes: 0,
        };
      }
      throw error;
    }

    const sourceBytes = bytes.byteLength;
    const content = bytes.toString("utf8");
    if (content.length === 0) {
      return {
        events: [],
        diagnostics: [],
        sourceBytes,
        indexedBytes: 0,
      };
    }

    const hasTrailingNewline = content.endsWith("\n");
    const lines = content.split("\n");
    if (hasTrailingNewline) {
      lines.pop();
    }

    const events: AgentEvent[] = [];
    const diagnostics: EventReadResult["diagnostics"] = [];
    let indexedBytes = sourceBytes;

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
          indexedBytes = bytes.lastIndexOf(10) + 1;
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
          indexedBytes = bytes.lastIndexOf(10) + 1;
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

    return { events, diagnostics, sourceBytes, indexedBytes };
  }

  public async prepareForAppend(options: {
    discardPartialTrailingLine: boolean;
  }): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      let bytes: Buffer;
      try {
        bytes = await readFile(this.filePath);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return;
        }
        throw error;
      }
      if (bytes.byteLength === 0) {
        return;
      }
      if (options.discardPartialTrailingLine) {
        const finalNewline = bytes.lastIndexOf(10);
        await truncate(this.filePath, finalNewline + 1);
        return;
      }
      if (bytes.at(-1) !== 10) {
        await appendFile(this.filePath, "\n", "utf8");
      }
    });
    await this.writeChain;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
