export interface ScenarioCheck {
  name: string;
  passed: boolean;
  details?: string;
}

export interface ScenarioDefinition {
  id: string;
  description: string;
  run(): Promise<readonly ScenarioCheck[]>;
}

export interface ScenarioReport {
  id: string;
  description: string;
  passed: boolean;
  durationMs: number;
  checks: readonly ScenarioCheck[];
}

export function binaryCheck(
  name: string,
  passed: boolean,
  details?: string,
): ScenarioCheck {
  return {
    name,
    passed,
    ...(details === undefined ? {} : { details: boundDiagnostic(details) }),
  };
}

export async function evaluateScenario(
  definition: ScenarioDefinition,
): Promise<ScenarioReport> {
  const startedAt = performance.now();
  let checks: readonly ScenarioCheck[];
  try {
    checks = await definition.run();
    if (checks.length === 0) {
      checks = [
        binaryCheck(
          "scenario declares at least one binary check",
          false,
          "The scenario returned an empty check list.",
        ),
      ];
    }
  } catch (error) {
    checks = [
      binaryCheck(
        "scenario executes without an unhandled error",
        false,
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      ),
    ];
  }
  return {
    id: definition.id,
    description: definition.description,
    passed: checks.every((check) => check.passed),
    durationMs: Math.max(0, performance.now() - startedAt),
    checks,
  };
}

export function formatScenarioReport(report: ScenarioReport): string {
  const lines = [
    `${report.passed ? "PASS" : "FAIL"} ${report.id}: ${report.description}`,
  ];
  for (const check of report.checks) {
    lines.push(`  ${check.passed ? "PASS" : "FAIL"} ${check.name}`);
    if (!check.passed && check.details !== undefined) {
      lines.push(`    ${check.details}`);
    }
  }
  return lines.join("\n");
}

function boundDiagnostic(value: string): string {
  const normalized = value.replace(/[\r\n]+/gu, " ").trim();
  return normalized.length <= 1_000
    ? normalized
    : `${normalized.slice(0, 997)}...`;
}
