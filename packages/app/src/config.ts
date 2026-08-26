import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS,
  type ApprovalMode,
} from "@koda/agent-core";
import { threadIdSchema, type ThreadId } from "@koda/protocol";

export interface RunConfigurationInput {
  approvalMode?: string;
  cwd?: string;
  model?: string;
  resume?: string;
}

export interface RunConfiguration {
  approvalMode: ApprovalMode;
  apiKey: string;
  cwd: string;
  kodaHome: string;
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  resumeThreadId?: ThreadId;
}

export class ConfigurationError extends Error {
  public readonly code = "INVALID_CONFIGURATION";

  public constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function resolveKodaHome(environment: NodeJS.ProcessEnv): string {
  return resolve(environment.KODA_HOME?.trim() || resolve(homedir(), ".koda"));
}

export function parseLocalThreadId(input: string): ThreadId {
  const candidate = input.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(candidate)) {
    throw new ConfigurationError(
      "Thread ID must use 1-128 letters, digits, underscores, or hyphens and cannot contain path syntax.",
    );
  }
  return threadIdSchema.parse(candidate);
}

export function resolveRunConfiguration(
  input: RunConfigurationInput,
  environment: NodeJS.ProcessEnv,
  processDirectory: string,
): RunConfiguration {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new ConfigurationError(
      "OPENAI_API_KEY is required. Set it in the environment before running Koda.",
    );
  }

  const model =
    input.model?.trim() || environment.KODA_MODEL?.trim() || "gpt-5.6-terra";
  const approvalMode =
    input.approvalMode?.trim() ||
    environment.KODA_APPROVAL_MODE?.trim() ||
    "on-request";
  if (approvalMode !== "on-request" && approvalMode !== "never") {
    throw new ConfigurationError(
      "Approval mode must be either 'on-request' or 'never'.",
    );
  }
  const cwd = resolve(processDirectory, input.cwd?.trim() || ".");
  const kodaHome = resolveKodaHome(environment);
  const contextWindowTokens = parsePositiveInteger(
    environment.KODA_CONTEXT_WINDOW_TOKENS,
    "KODA_CONTEXT_WINDOW_TOKENS",
    128_000,
  );
  const maxOutputTokens = parsePositiveInteger(
    environment.KODA_MAX_OUTPUT_TOKENS,
    "KODA_MAX_OUTPUT_TOKENS",
    16_384,
  );
  if (
    contextWindowTokens <=
    maxOutputTokens + DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS
  ) {
    throw new ConfigurationError(
      `KODA_CONTEXT_WINDOW_TOKENS must exceed KODA_MAX_OUTPUT_TOKENS plus the ${DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS}-token safety margin.`,
    );
  }

  let resumeThreadId: ThreadId | undefined;
  if (input.resume !== undefined) {
    try {
      resumeThreadId = parseLocalThreadId(input.resume);
    } catch {
      throw new ConfigurationError(
        "Resume thread ID must use 1-128 letters, digits, underscores, or hyphens and cannot contain path syntax.",
      );
    }
  }

  return {
    approvalMode,
    apiKey,
    cwd,
    kodaHome,
    model,
    contextWindowTokens,
    maxOutputTokens,
    ...(resumeThreadId === undefined ? {} : { resumeThreadId }),
  };
}

function parsePositiveInteger(
  rawValue: string | undefined,
  name: string,
  defaultValue: number,
): number {
  const value = rawValue?.trim();
  if (value === undefined || value.length === 0) {
    return defaultValue;
  }
  if (!/^\d+$/u.test(value)) {
    throw new ConfigurationError(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ConfigurationError(`${name} must be a positive integer.`);
  }
  return parsed;
}
