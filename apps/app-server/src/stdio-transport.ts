import type { Readable } from "node:stream";

import { KodaAppServer } from "./server.js";

const DEFAULT_MAXIMUM_LINE_BYTES = 1_048_576;

export interface StdioTransportOptions {
  maximumLineBytes?: number;
}

export class ProtocolLineTooLargeError extends Error {
  public constructor(public readonly maximumLineBytes: number) {
    super(`JSON-RPC input line exceeds ${maximumLineBytes} bytes.`);
    this.name = "ProtocolLineTooLargeError";
  }
}

export async function runStdioTransport(
  server: KodaAppServer,
  input: Readable,
  options: StdioTransportOptions = {},
): Promise<void> {
  const maximumLineBytes =
    options.maximumLineBytes ?? DEFAULT_MAXIMUM_LINE_BYTES;
  if (!Number.isSafeInteger(maximumLineBytes) || maximumLineBytes < 1) {
    throw new RangeError("maximumLineBytes must be a positive safe integer.");
  }
  try {
    for await (const line of readLines(input, maximumLineBytes)) {
      await server.handleLine(line);
      if (server.shouldClose) {
        return;
      }
    }
  } finally {
    if (!server.shouldClose) {
      await server.disconnect();
    }
  }
}

async function* readLines(
  input: Readable,
  maximumLineBytes: number,
): AsyncIterable<string> {
  let buffered = Buffer.alloc(0);
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    buffered = Buffer.concat([buffered, bytes]);
    let newline = buffered.indexOf(10);
    while (newline >= 0) {
      if (newline > maximumLineBytes) {
        throw new ProtocolLineTooLargeError(maximumLineBytes);
      }
      let line = buffered.subarray(0, newline);
      if (line.at(-1) === 13) {
        line = line.subarray(0, -1);
      }
      yield line.toString("utf8");
      buffered = buffered.subarray(newline + 1);
      newline = buffered.indexOf(10);
    }
    if (buffered.byteLength > maximumLineBytes) {
      throw new ProtocolLineTooLargeError(maximumLineBytes);
    }
  }
  if (buffered.byteLength > 0) {
    if (buffered.byteLength > maximumLineBytes) {
      throw new ProtocolLineTooLargeError(maximumLineBytes);
    }
    if (buffered.at(-1) === 13) {
      buffered = buffered.subarray(0, -1);
    }
    yield buffered.toString("utf8");
  }
}
