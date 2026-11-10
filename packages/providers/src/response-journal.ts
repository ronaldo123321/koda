import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type OpenAI from "openai";
import {
  threadIdSchema,
  turnIdSchema,
  type ThreadId,
  type TurnId,
} from "@koda/protocol";
import { ProviderError } from "./errors.js";

export interface ResponseJournalHeader {
  version: 1;
  threadId: ThreadId;
  turnId: TurnId;
  step: number;
  binding: string;
}
export interface ResponseJournalSnapshot {
  header: ResponseJournalHeader;
  events: OpenAI.Responses.ResponseStreamEvent[];
}
const MAX_BYTES = 16 * 1024 * 1024;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invalid = () =>
  new ProviderError(
    "PROVIDER_PROTOCOL_ERROR",
    "The durable response journal is invalid or exceeds its limit.",
  );

/** One writer, protected by the application's thread lease. Never stores credentials. */
export class ResponseJournal {
  private bytes = 0;
  private count = 0;
  constructor(readonly path: string) {}

  async load(): Promise<ResponseJournalSnapshot | undefined> {
    let file;
    try {
      file = await open(this.path, constants.O_RDWR | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES)
        throw invalid();
      const bytes = await file.readFile();
      // Only a torn final append is discarded. Complete malformed records fail closed.
      const end = bytes.lastIndexOf(10) + 1;
      const lines = bytes
        .subarray(0, end)
        .toString("utf8")
        .split("\n")
        .slice(0, -1);
      const records = lines.map((line) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw invalid();
        }
        if (!parsed || typeof parsed !== "object") throw invalid();
        const record = parsed as { value: unknown; digest: string };
        if (record.digest !== digest(record.value)) throw invalid();
        return record.value;
      });
      const header = records.shift() as ResponseJournalHeader | undefined;
      if (
        !header ||
        header.version !== 1 ||
        !/^[a-f0-9]{64}$/.test(header.binding) ||
        !Number.isSafeInteger(header.step) ||
        header.step < 1
      )
        throw invalid();
      threadIdSchema.parse(header.threadId);
      turnIdSchema.parse(header.turnId);
      if (records.length > 100_000) throw invalid();
      for (const value of records) {
        if (
          !value ||
          typeof value !== "object" ||
          !("type" in value) ||
          typeof value.type !== "string" ||
          !("sequence_number" in value) ||
          !Number.isSafeInteger(value.sequence_number)
        )
          throw invalid();
      }
      if (end !== bytes.length) {
        await file.truncate(end);
        await file.sync();
      }
      this.bytes = end;
      this.count = records.length;
      return {
        header,
        events: records as OpenAI.Responses.ResponseStreamEvent[],
      };
    } finally {
      await file.close();
    }
  }

  async begin(header: ResponseJournalHeader): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    const line = this.line(header);
    try {
      await file.writeFile(line);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, this.path);
      await this.syncDirectory();
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    this.bytes = Buffer.byteLength(line);
    this.count = 0;
  }

  async append(event: OpenAI.Responses.ResponseStreamEvent): Promise<void> {
    const line = this.line(event);
    const size = Buffer.byteLength(line);
    if (this.bytes + size > MAX_BYTES || this.count >= 100_000) throw invalid();
    const file = await open(
      this.path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== this.bytes)
        throw invalid();
      await file.writeFile(line);
      await file.sync();
      this.bytes += size;
      this.count += 1;
    } finally {
      await file.close();
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path);
      await this.syncDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private line(value: unknown) {
    return JSON.stringify({ value, digest: digest(value) }) + "\n";
  }
  private async syncDirectory() {
    const directory = await open(dirname(this.path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
