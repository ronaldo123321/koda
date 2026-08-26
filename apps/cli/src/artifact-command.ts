import {
  ArtifactGarbageCollectionError,
  ArtifactGarbageCollector,
  type ArtifactGarbageCollectionReport,
} from "@koda/runtime-node";

import { resolveKodaHome } from "./config.js";
import type { TextWriter } from "./console-event-sink.js";

export interface ArtifactGarbageCollectionCommandInput {
  delete?: boolean;
  minAgeHours?: string;
}

export interface ArtifactCommandContext {
  environment: NodeJS.ProcessEnv;
  stdout: TextWriter;
  stderr: TextWriter;
}

export async function runArtifactGarbageCollectionCommand(
  input: ArtifactGarbageCollectionCommandInput,
  context: ArtifactCommandContext,
): Promise<number> {
  let minimumAgeMs: number;
  try {
    minimumAgeMs = parseMinimumAgeHours(input.minAgeHours);
  } catch (error) {
    context.stderr.write(`[koda] ${errorMessage(error)}\n`);
    return 2;
  }

  try {
    const collector = new ArtifactGarbageCollector(
      resolveKodaHome(context.environment),
    );
    const report = await collector.collect({
      delete: input.delete === true,
      minimumAgeMs,
    });
    writeReport(context.stdout, context.stderr, report);
    return 0;
  } catch (error) {
    const code =
      error instanceof ArtifactGarbageCollectionError ? `${error.code}: ` : "";
    context.stderr.write(`[koda] ${code}${errorMessage(error)}\n`);
    return 1;
  }
}

function parseMinimumAgeHours(input: string | undefined): number {
  const value = input?.trim() || "24";
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value)) {
    throw new Error(
      "Artifact minimum age must be a non-negative number of hours.",
    );
  }
  const milliseconds = Number(value) * 60 * 60 * 1_000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error(
      "Artifact minimum age must resolve to a non-negative whole number of milliseconds.",
    );
  }
  return milliseconds;
}

function writeReport(
  stdout: TextWriter,
  stderr: TextWriter,
  report: ArtifactGarbageCollectionReport,
): void {
  stdout.write(
    `Artifact GC ${report.mode === "dry-run" ? "dry run" : "delete"}\n`,
  );
  stdout.write(`Minimum age: ${formatDuration(report.minimumAgeMs)}\n`);
  stdout.write(`Thread logs scanned: ${report.logsScanned}\n`);
  stdout.write(`Artifact blobs scanned: ${report.artifactsScanned}\n`);
  stdout.write(`Reachable artifact IDs: ${report.reachableArtifacts}\n`);
  stdout.write(`Deletion candidates: ${report.candidates.length}\n`);
  stdout.write(`Deleted artifacts: ${report.deletedArtifacts}\n`);
  stdout.write(`Reclaimable bytes: ${report.reclaimableBytes}\n`);
  stdout.write(`Reclaimed bytes: ${report.reclaimedBytes}\n`);
  for (const candidate of report.candidates) {
    stdout.write(`  ${candidate.id}\t${candidate.bytes} bytes\n`);
  }
  for (const diagnostic of report.diagnostics) {
    stderr.write(
      `[koda] warning: ${formatLine(diagnostic.path)}: ${formatLine(diagnostic.message)}\n`,
    );
  }
}

function formatDuration(milliseconds: number): string {
  const hours = milliseconds / (60 * 60 * 1_000);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function formatLine(value: string): string {
  return value.replace(/[\t\r\n]/gu, " ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
