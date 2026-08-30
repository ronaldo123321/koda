import {
  EXECUTION_SECRET_MAX_SELECTION,
  EXECUTION_SECRET_VALUE_MAX_BYTES,
  EXECUTION_SECRET_VALUE_MIN_BYTES,
  EXECUTION_SECRET_VALUES_MAX_BYTES,
} from "@koda/protocol";

import { SecretPolicyError } from "./secret-policy.js";

export const SECRET_REDACTION_MARKER = Buffer.from("[REDACTED]", "ascii");

/** Exact-byte streaming redaction. This is defense against accidental output
 * disclosure, not transformed, encoded, or deliberately fragmented output.
 */
export class StreamingSecretRedactor {
  private readonly patterns: Buffer[];
  private readonly maximumPatternBytes: number;
  private pending = Buffer.alloc(0);
  private finished = false;
  private replacements = 0;

  public constructor(values: readonly Uint8Array[]) {
    if (values.length > EXECUTION_SECRET_MAX_SELECTION) {
      throw new SecretPolicyError("SECRET_VALUE_INVALID");
    }
    let totalBytes = 0;
    const patterns: Buffer[] = [];
    for (const value of values) {
      const pattern = Buffer.from(value);
      totalBytes += pattern.byteLength;
      if (
        pattern.byteLength < EXECUTION_SECRET_VALUE_MIN_BYTES ||
        pattern.byteLength > EXECUTION_SECRET_VALUE_MAX_BYTES ||
        totalBytes > EXECUTION_SECRET_VALUES_MAX_BYTES
      ) {
        pattern.fill(0);
        for (const accepted of patterns) accepted.fill(0);
        throw new SecretPolicyError("SECRET_VALUE_INVALID");
      }
      patterns.push(pattern);
    }
    patterns.sort((left, right) => {
      const lengthOrder = right.byteLength - left.byteLength;
      return lengthOrder === 0 ? Buffer.compare(left, right) : lengthOrder;
    });
    this.patterns = patterns.filter((pattern, index) => {
      const duplicate = index > 0 && pattern.equals(patterns[index - 1]!);
      if (duplicate) pattern.fill(0);
      return !duplicate;
    });
    this.maximumPatternBytes = this.patterns[0]?.byteLength ?? 0;
  }

  public get replacementCount(): number {
    return this.replacements;
  }

  public push(chunk: Uint8Array): Buffer {
    this.assertOpen();
    if (this.patterns.length === 0) return Buffer.from(chunk);

    const previous = this.pending;
    const combined = Buffer.concat([previous, Buffer.from(chunk)]);
    previous.fill(0);
    try {
      return this.process(combined, false);
    } catch (error) {
      this.destroy();
      throw error;
    } finally {
      combined.fill(0);
    }
  }

  public finish(): Buffer {
    this.assertOpen();
    this.finished = true;
    if (this.patterns.length === 0) return Buffer.alloc(0);

    const final = this.pending;
    this.pending = Buffer.alloc(0);
    try {
      return this.process(final, true);
    } finally {
      final.fill(0);
      this.clearPatterns();
    }
  }

  public destroy(): void {
    this.finished = true;
    this.pending.fill(0);
    this.pending = Buffer.alloc(0);
    this.clearPatterns();
  }

  private process(input: Buffer, final: boolean): Buffer {
    const output: Buffer[] = [];
    let cursor = 0;
    let literalStart = 0;
    while (
      cursor < input.byteLength &&
      (final || input.byteLength - cursor >= this.maximumPatternBytes)
    ) {
      const match = this.patterns.find((pattern) =>
        input.subarray(cursor, cursor + pattern.byteLength).equals(pattern),
      );
      if (match === undefined) {
        cursor += 1;
        continue;
      }
      if (literalStart < cursor)
        output.push(input.subarray(literalStart, cursor));
      output.push(SECRET_REDACTION_MARKER);
      cursor += match.byteLength;
      literalStart = cursor;
      this.replacements += 1;
      if (!Number.isSafeInteger(this.replacements)) {
        throw new SecretPolicyError("SECRET_REDACTION_FAILED");
      }
    }
    if (literalStart < cursor)
      output.push(input.subarray(literalStart, cursor));
    if (final) {
      if (cursor < input.byteLength) output.push(input.subarray(cursor));
    } else {
      this.pending = Buffer.from(input.subarray(cursor));
    }
    return Buffer.concat(output);
  }

  private assertOpen(): void {
    if (this.finished) {
      throw new SecretPolicyError("SECRET_REDACTION_FAILED");
    }
  }

  private clearPatterns(): void {
    for (const pattern of this.patterns) pattern.fill(0);
  }
}
