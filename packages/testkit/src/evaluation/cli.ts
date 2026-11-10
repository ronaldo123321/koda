import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runEvaluation, type EvaluationOptions } from "./model-evaluation.js";

export function parseEvaluationArguments(args: readonly string[]) {
  const options: EvaluationOptions = {
    live: false,
    suite: "summaries",
    timeoutMs: 90_000,
  };
  let output = resolve("evaluation-results", `models-${Date.now()}.json`);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === "--live") {
      options.live = true;
      continue;
    }
    if (
      ![
        "--provider",
        "--model",
        "--suite",
        "--timeout-ms",
        "--output",
        "--probe",
      ].includes(flag)
    )
      throw new Error("Unknown evaluation option.");
    const value = args[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${flag}`);
    if (flag === "--provider") {
      if (value !== "openai" && value !== "anthropic")
        throw new Error("Provider must be openai or anthropic.");
      options.provider = value;
    } else if (flag === "--probe") {
      if (
        value !== "cancel" &&
        value !== "cancel-created" &&
        value !== "cancel-progress" &&
        value !== "retry" &&
        value !== "resume"
      )
        throw new Error(
          "Probe must be cancel, cancel-created, cancel-progress, retry or resume.",
        );
      options.probe = value;
    } else if (flag === "--model") {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value))
        throw new Error("Invalid model identifier.");
      options.model = value;
    } else if (flag === "--suite") {
      if (!["summaries", "transport", "all"].includes(value))
        throw new Error("Suite must be summaries, transport or all.");
      options.suite = value as EvaluationOptions["suite"];
    } else if (flag === "--timeout-ms") {
      const timeout = Number(value);
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120_000)
        throw new Error(
          "Timeout must be an integer between 1000 and 120000 ms.",
        );
      options.timeoutMs = timeout;
    } else output = resolve(value);
  }
  if (options.live && (!options.provider || !options.model))
    throw new Error("Live evaluation requires --provider and --model.");
  if (options.probe && options.suite !== "transport")
    throw new Error("--probe requires --suite transport.");
  return { options, output };
}

export async function saveEvaluation(
  options: EvaluationOptions,
  environment: NodeJS.ProcessEnv,
  output: string,
) {
  // Reserve the destination before any billable request. A reused/unwritable
  // output path must not discard a fresh paid evaluation.
  await mkdir(dirname(output), { recursive: true });
  const file = await open(output, "wx", 0o600);
  try {
    const report = await runEvaluation(options, environment);
    await file.writeFile(JSON.stringify(report, null, 2) + "\n");
    return report;
  } finally {
    await file.close();
  }
}

async function main() {
  const { options, output } = parseEvaluationArguments(process.argv.slice(2));
  const report = await saveEvaluation(options, process.env, output);
  console.log(
    JSON.stringify({
      status: report.status,
      mode: report.mode,
      report: output,
    }),
  );
  process.exitCode =
    report.status === "blocked" || report.status === "not_run"
      ? 2
      : report.status === "failed"
        ? 1
        : 0;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch(() => {
    console.error(
      "Evaluation could not finish. Check arguments, output path and local build; no raw provider errors are printed.",
    );
    process.exitCode = 1;
  });
}
