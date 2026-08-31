import { z } from "zod";

import {
  KODA_DISTRIBUTION_ERROR_CODES,
  KodaDistributionError,
  distributionError,
} from "./errors.js";
import {
  resolveKodaInstallation,
  verifyFullIntegrity,
  type ResolveKodaInstallationOptions,
} from "./installation.js";
import { BUNDLE_DOCTOR_SCHEMA_VERSION, KODA_VERSION } from "./version.js";

export const bundleDoctorCheckIdSchema = z.enum([
  "bundle.discovery",
  "bundle.manifest",
  "bundle.compatibility",
  "bundle.critical_integrity",
  "bundle.full_integrity",
]);

export const bundleDoctorCheckSchema = z
  .object({
    id: bundleDoctorCheckIdSchema,
    status: z.enum(["passed", "failed", "skipped"]),
    message: z.string().min(1).max(512),
    code: z.enum(KODA_DISTRIBUTION_ERROR_CODES).optional(),
  })
  .strict();

export const bundleDoctorReportSchema = z
  .object({
    schema_version: z.literal(BUNDLE_DOCTOR_SCHEMA_VERSION),
    koda_version: z.literal(KODA_VERSION),
    mode: z.enum(["development", "release", "invalid"]),
    status: z.enum(["passed", "failed", "development"]),
    checks: z.array(bundleDoctorCheckSchema).min(1).max(16),
  })
  .strict();

export type BundleDoctorCheck = z.infer<typeof bundleDoctorCheckSchema>;
export type BundleDoctorReport = z.infer<typeof bundleDoctorReportSchema>;

export interface RunBundleDoctorOptions extends ResolveKodaInstallationOptions {
  full?: boolean;
}

export async function runBundleDoctor(
  options: RunBundleDoctorOptions,
): Promise<BundleDoctorReport> {
  try {
    const installation = await resolveKodaInstallation({
      anchor: options.anchor,
      ...(options.expectedPlatform === undefined
        ? {}
        : { expectedPlatform: options.expectedPlatform }),
      ...(options.expectedArch === undefined
        ? {}
        : { expectedArch: options.expectedArch }),
      verifyCriticalFiles: true,
    });
    if (installation.mode === "development") {
      return bundleDoctorReportSchema.parse({
        schema_version: BUNDLE_DOCTOR_SCHEMA_VERSION,
        koda_version: KODA_VERSION,
        mode: "development",
        status: "development",
        checks: [
          {
            id: "bundle.discovery",
            status: "skipped",
            message:
              "Source development mode is active; no installed release bundle was discovered.",
          },
        ],
      });
    }

    const checks: BundleDoctorCheck[] = [
      {
        id: "bundle.discovery",
        status: "passed",
        message: "Installed Koda release bundle discovered.",
      },
      {
        id: "bundle.manifest",
        status: "passed",
        message: "Runtime manifest and integrity inventory are valid.",
      },
      {
        id: "bundle.compatibility",
        status: "passed",
        message: "Bundle version, platform, architecture, and protocols match.",
      },
      {
        id: "bundle.critical_integrity",
        status: "passed",
        message: "Critical runtime components match the integrity inventory.",
      },
    ];
    if (options.full === false) {
      checks.push({
        id: "bundle.full_integrity",
        status: "skipped",
        message: "Full payload integrity was not requested.",
      });
    } else {
      await verifyFullIntegrity(installation);
      checks.push({
        id: "bundle.full_integrity",
        status: "passed",
        message:
          "Every immutable payload file matches the integrity inventory.",
      });
    }
    return bundleDoctorReportSchema.parse({
      schema_version: BUNDLE_DOCTOR_SCHEMA_VERSION,
      koda_version: KODA_VERSION,
      mode: "release",
      status: "passed",
      checks,
    });
  } catch (error) {
    const bounded =
      error instanceof KodaDistributionError
        ? error
        : distributionError("KODA_BUNDLE_MANIFEST_INVALID", error);
    return bundleDoctorReportSchema.parse({
      schema_version: BUNDLE_DOCTOR_SCHEMA_VERSION,
      koda_version: KODA_VERSION,
      mode: "invalid",
      status: "failed",
      checks: [
        {
          id: checkIdForError(bounded),
          status: "failed",
          code: bounded.code,
          message: bounded.message,
        },
      ],
    });
  }
}

export function renderBundleDoctorReport(report: BundleDoctorReport): string {
  const parsed = bundleDoctorReportSchema.parse(report);
  const lines = [`Koda doctor ${parsed.koda_version}`];
  for (const check of parsed.checks) {
    lines.push(
      `[${check.status === "passed" ? "PASS" : check.status === "failed" ? "FAIL" : "SKIP"}] ${check.id}: ${check.message}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function bundleDoctorExitCode(report: BundleDoctorReport): number {
  return bundleDoctorReportSchema.parse(report).status === "failed" ? 1 : 0;
}

function checkIdForError(
  error: KodaDistributionError,
): BundleDoctorCheck["id"] {
  switch (error.code) {
    case "KODA_BUNDLE_PLATFORM_MISMATCH":
    case "KODA_BUNDLE_ARCH_MISMATCH":
    case "KODA_BUNDLE_VERSION_MISMATCH":
      return "bundle.compatibility";
    case "KODA_BUNDLE_INTEGRITY_FAILED":
      return "bundle.full_integrity";
    case "KODA_BUNDLE_COMPONENT_MISSING":
      return "bundle.critical_integrity";
    default:
      return "bundle.manifest";
  }
}
