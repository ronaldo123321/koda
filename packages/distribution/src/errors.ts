export const KODA_DISTRIBUTION_ERROR_CODES = [
  "KODA_BUNDLE_MANIFEST_INVALID",
  "KODA_BUNDLE_PLATFORM_MISMATCH",
  "KODA_BUNDLE_ARCH_MISMATCH",
  "KODA_BUNDLE_INTEGRITY_FAILED",
  "KODA_BUNDLE_COMPONENT_MISSING",
  "KODA_BUNDLE_VERSION_MISMATCH",
  "KODA_APP_SERVER_START_FAILED",
  "KODA_NATIVE_EXECUTOR_UNAVAILABLE",
  "KODA_PROVIDER_CREDENTIAL_MISSING",
] as const;

export type KodaDistributionErrorCode =
  (typeof KODA_DISTRIBUTION_ERROR_CODES)[number];

const ERROR_MESSAGES: Readonly<Record<KodaDistributionErrorCode, string>> = {
  KODA_BUNDLE_MANIFEST_INVALID:
    "The installed Koda runtime manifest is invalid. Run 'koda doctor --bundle-only' or reinstall Koda.",
  KODA_BUNDLE_PLATFORM_MISMATCH:
    "This Koda bundle does not support the current operating system. Install the matching macOS release.",
  KODA_BUNDLE_ARCH_MISMATCH:
    "This Koda bundle does not support the current CPU architecture. Install the matching Homebrew release.",
  KODA_BUNDLE_INTEGRITY_FAILED:
    "The installed Koda runtime failed its integrity check. Reinstall Koda before running it.",
  KODA_BUNDLE_COMPONENT_MISSING:
    "The installed Koda runtime is incomplete. Reinstall Koda before running it.",
  KODA_BUNDLE_VERSION_MISMATCH:
    "The installed Koda components do not share one compatible version. Reinstall Koda before running it.",
  KODA_APP_SERVER_START_FAILED:
    "Koda could not start its local app-server. Run 'koda doctor' for bounded diagnostics.",
  KODA_NATIVE_EXECUTOR_UNAVAILABLE:
    "Koda's native executor is unavailable. Run 'koda doctor' or reinstall Koda.",
  KODA_PROVIDER_CREDENTIAL_MISSING:
    "The selected Provider credential is unavailable. Configure its documented environment variable.",
};

export class KodaDistributionError extends Error {
  public constructor(
    public readonly code: KodaDistributionErrorCode,
    options?: ErrorOptions,
  ) {
    super(ERROR_MESSAGES[code], options);
    this.name = "KodaDistributionError";
  }
}

export function distributionError(
  code: KodaDistributionErrorCode,
  cause?: unknown,
): KodaDistributionError {
  return new KodaDistributionError(code, {
    ...(cause === undefined ? {} : { cause }),
  });
}
