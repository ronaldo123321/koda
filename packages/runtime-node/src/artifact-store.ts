import { createReadStream, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  artifactIdSchema,
  artifactReferenceSchema,
  type ArtifactId,
  type ArtifactReference,
} from "@koda/protocol";

export type ArtifactErrorCode =
  | "INVALID_ARTIFACT_ID"
  | "INVALID_ARTIFACT_RANGE"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_CORRUPT"
  | "ARTIFACT_MEDIA_TYPE_UNSUPPORTED"
  | "ARTIFACT_OUTPUT_LIMIT_EXCEEDED"
  | "ARTIFACT_WRITE_FAILED";

export class ArtifactError extends Error {
  public constructor(
    public readonly code: ArtifactErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArtifactError";
  }
}

export interface ArtifactStoreOptions {
  staleTemporaryFileAgeMs?: number;
  now?: () => number;
}

export interface TextCaptureOptions {
  inlineBytes?: number;
  maxBytes?: number;
  mediaType?: string;
}

interface ResolvedTextCaptureOptions {
  inlineBytes: number;
  maxBytes: number;
  mediaType: string;
}

export interface MaterializedTextOutput {
  text: string;
  totalBytes: number;
  truncated: boolean;
  artifact?: ArtifactReference;
}

export interface ArtifactRange {
  id: ArtifactId;
  content: string;
  startByte: number;
  endByte: number;
  totalBytes: number;
  truncated: boolean;
}

export interface VerifiedTextArtifactRange extends ArtifactRange {
  artifact: ArtifactReference;
  hasEarlier: boolean;
  hasLater: boolean;
}

export interface VerifiedTextArtifactRangeOptions {
  beforeByte?: number;
  afterByte?: number;
  maxBytes: number;
}

export interface UnavailableArtifact {
  id: ArtifactId;
  reason: "missing" | "corrupt";
}

const DEFAULT_INLINE_BYTES = 65_536;
const DEFAULT_MAX_ARTIFACT_BYTES = 67_108_864;
const DEFAULT_STALE_TEMPORARY_FILE_AGE_MS = 86_400_000;
const TAIL_FRACTION = 4;

export class ArtifactStore {
  private constructor(
    public readonly root: string,
    private readonly temporaryRoot: string,
  ) {}

  public static async open(
    root: string,
    options: ArtifactStoreOptions = {},
  ): Promise<ArtifactStore> {
    const requestedRoot = resolve(root);
    const temporaryRoot = join(requestedRoot, "tmp");
    await mkdir(temporaryRoot, { recursive: true });
    await mkdir(join(requestedRoot, "sha256"), { recursive: true });
    const canonicalRoot = await realpath(requestedRoot);
    const store = new ArtifactStore(canonicalRoot, join(canonicalRoot, "tmp"));
    await store.cleanupStaleTemporaryFiles(
      options.staleTemporaryFileAgeMs ?? DEFAULT_STALE_TEMPORARY_FILE_AGE_MS,
      (options.now ?? Date.now)(),
    );
    return store;
  }

  public static async openReadOnly(root: string): Promise<ArtifactStore> {
    const requestedRoot = resolve(root);
    try {
      const canonicalRoot = await realpath(requestedRoot);
      if (!(await stat(canonicalRoot)).isDirectory()) {
        throw new ArtifactError(
          "ARTIFACT_CORRUPT",
          "Artifact store root is not a directory.",
        );
      }
      return new ArtifactStore(canonicalRoot, join(canonicalRoot, "tmp"));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new ArtifactError(
          "ARTIFACT_NOT_FOUND",
          "Artifact store does not exist.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  public async materializeText(
    content: string,
    options: TextCaptureOptions = {},
  ): Promise<MaterializedTextOutput> {
    const resolved = resolveTextCaptureOptions(options);
    const totalBytes = Buffer.byteLength(content);
    if (totalBytes <= resolved.inlineBytes) {
      return { text: content, totalBytes, truncated: false };
    }
    if (totalBytes > resolved.maxBytes) {
      throw new ArtifactError(
        "ARTIFACT_OUTPUT_LIMIT_EXCEEDED",
        `Artifact output exceeded the ${resolved.maxBytes}-byte capture limit.`,
      );
    }
    const capture = await this.createTextCapture(resolved);
    try {
      await capture.append(content);
      return await capture.finish();
    } catch (error) {
      await capture.abort();
      throw error;
    }
  }

  public async createTextCapture(
    options: TextCaptureOptions = {},
  ): Promise<TextArtifactCapture> {
    const { inlineBytes, maxBytes, mediaType } =
      resolveTextCaptureOptions(options);
    const temporaryPath = join(this.temporaryRoot, `${randomUUID()}.part`);
    const handle = await open(temporaryPath, "wx", 0o600);
    return new TextArtifactCapture(
      this,
      temporaryPath,
      handle,
      inlineBytes,
      maxBytes,
      mediaType,
    );
  }

  public async verify(reference: ArtifactReference): Promise<void> {
    const parsed = artifactReferenceSchema.parse(reference);
    const path = this.pathForId(parsed.id);
    const fileStats = await this.statArtifact(path, parsed.id);
    if (fileStats.size !== parsed.bytes) {
      throw new ArtifactError(
        "ARTIFACT_CORRUPT",
        `Artifact '${parsed.id}' has ${fileStats.size} bytes instead of ${parsed.bytes}.`,
      );
    }
    const hash = await hashFile(path);
    if (hash !== parsed.sha256) {
      throw new ArtifactError(
        "ARTIFACT_CORRUPT",
        `Artifact '${parsed.id}' does not match its SHA-256 digest.`,
      );
    }
  }

  public async findUnavailable(
    references: readonly ArtifactReference[],
  ): Promise<UnavailableArtifact[]> {
    const unique = new Map(
      references.map((reference) => [reference.id, reference]),
    );
    const unavailable: UnavailableArtifact[] = [];
    for (const reference of unique.values()) {
      try {
        await this.verify(reference);
      } catch (error) {
        if (
          error instanceof ArtifactError &&
          error.code === "ARTIFACT_NOT_FOUND"
        ) {
          unavailable.push({ id: reference.id, reason: "missing" });
        } else if (
          error instanceof ArtifactError &&
          error.code === "ARTIFACT_CORRUPT"
        ) {
          unavailable.push({ id: reference.id, reason: "corrupt" });
        } else {
          throw error;
        }
      }
    }
    return unavailable;
  }

  public async readRange(
    inputId: string,
    offset: number,
    maxBytes: number,
  ): Promise<ArtifactRange> {
    const id = parseArtifactId(inputId);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ArtifactError(
        "INVALID_ARTIFACT_RANGE",
        "Artifact byte offset must be a non-negative integer.",
      );
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536) {
      throw new ArtifactError(
        "INVALID_ARTIFACT_RANGE",
        "Artifact maxBytes must be an integer between 1 and 65536.",
      );
    }
    const path = this.pathForId(id);
    const fileStats = await this.statArtifact(path, id);
    const expectedHash = id.slice("sha256:".length);
    const actualHash = await hashFile(path);
    if (actualHash !== expectedHash) {
      throw new ArtifactError(
        "ARTIFACT_CORRUPT",
        `Artifact '${id}' does not match its SHA-256 digest.`,
      );
    }
    const startByte = Math.min(offset, fileStats.size);
    const length = Math.min(maxBytes, fileStats.size - startByte);
    const buffer = Buffer.alloc(length);
    const handle = await open(path, "r");
    let bytesRead = 0;
    try {
      if (length > 0) {
        ({ bytesRead } = await handle.read(buffer, 0, length, startByte));
      }
    } finally {
      await handle.close();
    }
    const endByte = startByte + bytesRead;
    return {
      id,
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      startByte,
      endByte,
      totalBytes: fileStats.size,
      truncated: endByte < fileStats.size,
    };
  }

  public async readVerifiedTextRange(
    referenceInput: ArtifactReference,
    options: VerifiedTextArtifactRangeOptions,
  ): Promise<VerifiedTextArtifactRange> {
    const reference = artifactReferenceSchema.parse(referenceInput);
    if (
      reference.mediaType !== "text/plain; charset=utf-8" &&
      reference.mediaType !== "application/json"
    ) {
      throw new ArtifactError(
        "ARTIFACT_MEDIA_TYPE_UNSUPPORTED",
        `Artifact '${reference.id}' has unsupported media type '${reference.mediaType}'.`,
      );
    }
    if (options.beforeByte !== undefined && options.afterByte !== undefined) {
      throw new ArtifactError(
        "INVALID_ARTIFACT_RANGE",
        "Artifact beforeByte and afterByte cursors are mutually exclusive.",
      );
    }
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 4 ||
      options.maxBytes > 65_536
    ) {
      throw new ArtifactError(
        "INVALID_ARTIFACT_RANGE",
        "Artifact maxBytes must be a safe integer between 4 and 65536.",
      );
    }
    const cursor = options.beforeByte ?? options.afterByte ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new ArtifactError(
        "INVALID_ARTIFACT_RANGE",
        "Artifact byte cursor must be a non-negative safe integer.",
      );
    }

    const path = this.pathForId(reference.id);
    await this.assertRegularPath(path, reference.id);
    let handle: FileHandle;
    try {
      handle = await open(path, "r");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new ArtifactError(
          "ARTIFACT_NOT_FOUND",
          `Artifact '${reference.id}' does not exist.`,
          { cause: error },
        );
      }
      throw error;
    }
    try {
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new ArtifactError(
          "ARTIFACT_CORRUPT",
          `Artifact '${reference.id}' is not a regular file.`,
        );
      }
      if (before.size !== reference.bytes) {
        throw new ArtifactError(
          "ARTIFACT_CORRUPT",
          `Artifact '${reference.id}' has ${before.size} bytes instead of ${reference.bytes}.`,
        );
      }
      if (cursor > before.size) {
        throw new ArtifactError(
          "INVALID_ARTIFACT_RANGE",
          `Artifact byte cursor ${cursor} exceeds its ${before.size}-byte size.`,
        );
      }
      await assertUtf8Boundary(handle, cursor, before.size, reference.id);
      const digest = await hashAndValidateUtf8(
        handle,
        before.size,
        reference.id,
      );
      if (digest !== reference.sha256) {
        throw new ArtifactError(
          "ARTIFACT_CORRUPT",
          `Artifact '${reference.id}' does not match its SHA-256 digest.`,
        );
      }

      let startByte: number;
      let endByte: number;
      let contentBuffer: Buffer;
      if (options.beforeByte !== undefined) {
        endByte = options.beforeByte;
        const requestedStart = Math.max(0, endByte - options.maxBytes);
        const raw = await readHandleRange(
          handle,
          requestedStart,
          endByte - requestedStart,
        );
        contentBuffer = safeUtf8Tail(raw);
        startByte = endByte - contentBuffer.byteLength;
      } else {
        startByte = options.afterByte ?? 0;
        const raw = await readHandleRange(
          handle,
          startByte,
          Math.min(options.maxBytes + 3, before.size - startByte),
        );
        contentBuffer = safeUtf8Prefix(raw, options.maxBytes);
        endByte = startByte + contentBuffer.byteLength;
      }

      const after = await handle.stat();
      if (!sameFileSnapshot(before, after)) {
        throw new ArtifactError(
          "ARTIFACT_CORRUPT",
          `Artifact '${reference.id}' changed while it was being read.`,
        );
      }
      return {
        id: reference.id,
        artifact: reference,
        content: new TextDecoder("utf-8", { fatal: true }).decode(
          contentBuffer,
        ),
        startByte,
        endByte,
        totalBytes: before.size,
        truncated: endByte < before.size,
        hasEarlier: startByte > 0,
        hasLater: endByte < before.size,
      };
    } finally {
      await handle.close();
    }
  }

  public async publish(
    temporaryPath: string,
    sha256: string,
    bytes: number,
    mediaType: string,
  ): Promise<ArtifactReference> {
    if (
      dirname(resolve(temporaryPath)) !== this.temporaryRoot ||
      !temporaryPath.endsWith(".part")
    ) {
      throw new ArtifactError(
        "ARTIFACT_WRITE_FAILED",
        "Artifact publication requires a store-owned temporary file.",
      );
    }
    const id = artifactIdSchema.parse(`sha256:${sha256}`);
    const destination = this.pathForId(id);
    await mkdir(dirname(destination), { recursive: true });
    try {
      await link(temporaryPath, destination);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw new ArtifactError(
          "ARTIFACT_WRITE_FAILED",
          `Could not publish artifact '${id}'.`,
          { cause: error },
        );
      }
      const existing = await this.statArtifact(destination, id);
      if (existing.size !== bytes) {
        throw new ArtifactError(
          "ARTIFACT_CORRUPT",
          `Existing artifact '${id}' has an unexpected size.`,
        );
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
    return artifactReferenceSchema.parse({
      type: "artifact",
      id,
      sha256,
      bytes,
      mediaType,
    });
  }

  private pathForId(id: ArtifactId): string {
    const hash = id.slice("sha256:".length);
    return join(this.root, "sha256", hash.slice(0, 2), hash);
  }

  private async statArtifact(path: string, id: ArtifactId) {
    try {
      const fileStats = await stat(path);
      if (!fileStats.isFile()) {
        throw new ArtifactError(
          "ARTIFACT_CORRUPT",
          `Artifact '${id}' is not a regular file.`,
        );
      }
      return fileStats;
    } catch (error) {
      if (error instanceof ArtifactError) {
        throw error;
      }
      if (isNodeError(error, "ENOENT")) {
        throw new ArtifactError(
          "ARTIFACT_NOT_FOUND",
          `Artifact '${id}' does not exist.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async assertRegularPath(path: string, id: ArtifactId): Promise<void> {
    try {
      const pathStats = await lstat(path);
      if (!pathStats.isFile()) {
        throw new ArtifactError(
          "ARTIFACT_CORRUPT",
          `Artifact '${id}' is not a regular file.`,
        );
      }
    } catch (error) {
      if (error instanceof ArtifactError) {
        throw error;
      }
      if (isNodeError(error, "ENOENT")) {
        throw new ArtifactError(
          "ARTIFACT_NOT_FOUND",
          `Artifact '${id}' does not exist.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async cleanupStaleTemporaryFiles(
    maximumAgeMs: number,
    now: number,
  ): Promise<void> {
    if (!Number.isInteger(maximumAgeMs) || maximumAgeMs < 0) {
      throw new ArtifactError(
        "ARTIFACT_WRITE_FAILED",
        "Artifact stale temporary file age must be a non-negative integer.",
      );
    }
    const entries = await readdir(this.temporaryRoot, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.endsWith(".part")) {
          return;
        }
        const path = join(this.temporaryRoot, entry.name);
        let fileStats;
        try {
          fileStats = await stat(path);
        } catch (error) {
          if (isNodeError(error, "ENOENT")) {
            return;
          }
          throw error;
        }
        if (now - fileStats.mtimeMs >= maximumAgeMs) {
          await rm(path, { force: true });
        }
      }),
    );
  }
}

function resolveTextCaptureOptions(
  options: TextCaptureOptions,
): ResolvedTextCaptureOptions {
  const inlineBytes = options.inlineBytes ?? DEFAULT_INLINE_BYTES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  if (!Number.isInteger(inlineBytes) || inlineBytes < 1) {
    throw new ArtifactError(
      "ARTIFACT_WRITE_FAILED",
      "Artifact inlineBytes must be a positive integer.",
    );
  }
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < inlineBytes ||
    maxBytes > 1_073_741_824
  ) {
    throw new ArtifactError(
      "ARTIFACT_WRITE_FAILED",
      "Artifact maxBytes must be an integer between inlineBytes and 1073741824.",
    );
  }
  const mediaType = options.mediaType ?? "text/plain; charset=utf-8";
  if (mediaType.length === 0) {
    throw new ArtifactError(
      "ARTIFACT_WRITE_FAILED",
      "Artifact media type must not be empty.",
    );
  }
  return { inlineBytes, maxBytes, mediaType };
}

export class TextArtifactCapture {
  private readonly hash = createHash("sha256");
  private readonly prefixChunks: Buffer[] = [];
  private prefixBytes = 0;
  private tail = Buffer.alloc(0);
  private totalBytes = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private finishPromise: Promise<MaterializedTextOutput> | undefined;
  private closed = false;

  public constructor(
    private readonly store: ArtifactStore,
    private readonly temporaryPath: string,
    private readonly handle: FileHandle,
    private readonly inlineBytes: number,
    private readonly maxBytes: number,
    private readonly mediaType: string,
  ) {}

  public async append(chunk: Buffer | string): Promise<void> {
    if (this.closed || this.finishPromise !== undefined) {
      throw new ArtifactError(
        "ARTIFACT_WRITE_FAILED",
        "Cannot append to a finished artifact capture.",
      );
    }
    const bytes = Buffer.isBuffer(chunk)
      ? Buffer.from(chunk)
      : Buffer.from(chunk);
    this.writeChain = this.writeChain.then(async () => {
      if (this.totalBytes + bytes.byteLength > this.maxBytes) {
        throw new ArtifactError(
          "ARTIFACT_OUTPUT_LIMIT_EXCEEDED",
          `Artifact output exceeded the ${this.maxBytes}-byte capture limit.`,
        );
      }
      this.hash.update(bytes);
      this.totalBytes += bytes.byteLength;
      this.retainExcerpt(bytes);
      await this.handle.write(bytes);
    });
    await this.writeChain;
  }

  public finish(): Promise<MaterializedTextOutput> {
    this.finishPromise ??= this.finishInternal();
    return this.finishPromise;
  }

  public async abort(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.writeChain;
    } catch {
      // Cleanup still needs to run after a failed write.
    }
    try {
      await this.handle.close();
    } catch {
      // The handle may already be closed by finishInternal.
    }
    await rm(this.temporaryPath, { force: true });
  }

  private async finishInternal(): Promise<MaterializedTextOutput> {
    try {
      await this.writeChain;
      await this.handle.sync();
      await this.handle.close();
      this.closed = true;
      const sha256 = this.hash.digest("hex");
      if (this.totalBytes <= this.inlineBytes) {
        await rm(this.temporaryPath, { force: true });
        return {
          text: Buffer.concat(this.prefixChunks, this.prefixBytes).toString(
            "utf8",
          ),
          totalBytes: this.totalBytes,
          truncated: false,
        };
      }
      const artifact = await this.store.publish(
        this.temporaryPath,
        sha256,
        this.totalBytes,
        this.mediaType,
      );
      return {
        text: this.renderExcerpt(artifact),
        totalBytes: this.totalBytes,
        truncated: true,
        artifact,
      };
    } catch (error) {
      await this.abort();
      if (error instanceof ArtifactError) {
        throw error;
      }
      throw new ArtifactError(
        "ARTIFACT_WRITE_FAILED",
        "Could not finish artifact capture.",
        { cause: error },
      );
    }
  }

  private retainExcerpt(bytes: Buffer): void {
    const availablePrefix = this.inlineBytes - this.prefixBytes;
    if (availablePrefix > 0) {
      const retained = bytes.subarray(0, availablePrefix);
      this.prefixChunks.push(Buffer.from(retained));
      this.prefixBytes += retained.byteLength;
    }
    const tailBytes = Math.max(1, Math.floor(this.inlineBytes / TAIL_FRACTION));
    this.tail = Buffer.from(
      Buffer.concat([this.tail, bytes]).subarray(-tailBytes),
    );
  }

  private renderExcerpt(artifact: ArtifactReference): string {
    const prefix = Buffer.concat(this.prefixChunks, this.prefixBytes);
    let contentBudget = this.inlineBytes;
    let rendered = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const tailBudget = Math.max(1, Math.floor(contentBudget / TAIL_FRACTION));
      const headBudget = Math.max(0, contentBudget - tailBudget);
      const head = safeUtf8Prefix(prefix, headBudget);
      const tail = safeUtf8Tail(this.tail.subarray(-tailBudget));
      const omittedBytes = Math.max(
        0,
        this.totalBytes - head.byteLength - tail.byteLength,
      );
      const marker = `\n... [${omittedBytes} bytes omitted; full output in ${artifact.id}] ...\n`;
      const markerBytes = Buffer.byteLength(marker);
      if (markerBytes >= this.inlineBytes) {
        return safeUtf8Prefix(prefix, this.inlineBytes).toString("utf8");
      }
      rendered = `${head.toString("utf8")}${marker}${tail.toString("utf8")}`;
      const nextContentBudget = this.inlineBytes - markerBytes;
      if (nextContentBudget === contentBudget) {
        break;
      }
      contentBudget = nextContentBudget;
    }
    return rendered;
  }
}

function parseArtifactId(value: string): ArtifactId {
  const parsed = artifactIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new ArtifactError(
      "INVALID_ARTIFACT_ID",
      "Artifact ID must use the form 'sha256:' followed by 64 lowercase hexadecimal characters.",
    );
  }
  return parsed.data;
}

function safeUtf8Prefix(buffer: Buffer, maximumBytes: number): Buffer {
  let end = Math.min(maximumBytes, buffer.byteLength);
  if (end === buffer.byteLength) {
    return buffer;
  }
  while (end > 0 && isUtf8ContinuationByte(buffer[end] ?? 0)) {
    end -= 1;
  }
  return buffer.subarray(0, end);
}

function safeUtf8Tail(buffer: Buffer): Buffer {
  let start = 0;
  while (
    start < buffer.byteLength &&
    isUtf8ContinuationByte(buffer[start] ?? 0)
  ) {
    start += 1;
  }
  return buffer.subarray(start);
}

function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

async function assertUtf8Boundary(
  handle: FileHandle,
  offset: number,
  totalBytes: number,
  id: ArtifactId,
): Promise<void> {
  if (offset === 0 || offset === totalBytes) {
    return;
  }
  const value = await readHandleRange(handle, offset, 1);
  if (isUtf8ContinuationByte(value[0] ?? 0)) {
    throw new ArtifactError(
      "INVALID_ARTIFACT_RANGE",
      `Artifact byte cursor ${offset} is not a UTF-8 character boundary for '${id}'.`,
    );
  }
}

async function hashAndValidateUtf8(
  handle: FileHandle,
  totalBytes: number,
  id: ArtifactId,
): Promise<string> {
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.allocUnsafe(65_536);
  let position = 0;
  try {
    while (position < totalBytes) {
      const length = Math.min(buffer.byteLength, totalBytes - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) {
        throw new ArtifactError(
          "ARTIFACT_CORRUPT",
          `Artifact '${id}' ended while it was being verified.`,
        );
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      decoder.decode(chunk, { stream: true });
      position += bytesRead;
    }
    decoder.decode();
  } catch (error) {
    if (error instanceof ArtifactError) {
      throw error;
    }
    throw new ArtifactError(
      "ARTIFACT_CORRUPT",
      `Artifact '${id}' is not valid UTF-8 text.`,
      { cause: error },
    );
  }
  return hash.digest("hex");
}

async function readHandleRange(
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let totalRead = 0;
  while (totalRead < length) {
    const { bytesRead } = await handle.read(
      buffer,
      totalRead,
      length - totalRead,
      position + totalRead,
    );
    if (bytesRead === 0) {
      break;
    }
    totalRead += bytesRead;
  }
  return buffer.subarray(0, totalRead);
}

function sameFileSnapshot(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.once("error", rejectPromise);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
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
