import { describe, expect, it } from "vitest";

import { phase2ReliabilityScenarios } from "./phase-2-reliability-scenarios.js";
import { evaluateScenario, formatScenarioReport } from "./scenario-runner.js";

describe("Phase 2 deterministic reliability scenarios", () => {
  it.each(phase2ReliabilityScenarios)(
    "$id: $description",
    async (definition) => {
      const report = await evaluateScenario(definition);

      expect(report.passed, formatScenarioReport(report)).toBe(true);
      expect(report.checks.length).toBeGreaterThan(0);
      expect(report.checks.every((check) => check.passed)).toBe(true);
    },
    15_000,
  );
});
