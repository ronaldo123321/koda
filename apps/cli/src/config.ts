import { homedir } from "node:os";
import { resolve } from "node:path";

import type { ApprovalMode } from "@koda/agent-core";
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
  resumeThreadId?: ThreadId;
}

export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
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
  const kodaHome = resolve(
    environment.KODA_HOME?.trim() || resolve(homedir(), ".koda"),
  );

  let resumeThreadId: ThreadId | undefined;
  if (input.resume !== undefined) {
    const candidate = input.resume.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(candidate)) {
      throw new ConfigurationError(
        "Resume thread ID must use 1-128 letters, digits, underscores, or hyphens and cannot contain path syntax.",
      );
    }
    resumeThreadId = threadIdSchema.parse(candidate);
  }

  return {
    approvalMode,
    apiKey,
    cwd,
    kodaHome,
    model,
    ...(resumeThreadId === undefined ? {} : { resumeThreadId }),
  };
}
