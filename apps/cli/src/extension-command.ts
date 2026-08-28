import { KodaApplication } from "@koda/app";
import {
  commandTemplateIdSchema,
  skillIdSchema,
  type ExtensionSourceKind,
} from "@koda/protocol";

import type { TextWriter } from "./console-event-sink.js";

export interface ExtensionCommandContext {
  environment: NodeJS.ProcessEnv;
  processDirectory: string;
  stdout: TextWriter;
  stderr: TextWriter;
}

export interface ExtensionCommandInput {
  workspace?: string;
}

export async function runExtensionListCommand(
  input: ExtensionCommandInput,
  context: ExtensionCommandContext,
): Promise<number> {
  try {
    const result = await createApplication(context).inspectExtensionCatalog({
      workspace: input.workspace?.trim() || ".",
    });
    context.stdout.write(`Workspace: ${formatCell(result.workspace)}\n`);
    context.stdout.write(`Catalog: ${result.catalogSha256}\n`);
    context.stdout.write(`Skills (${result.skills.length})\n`);
    for (const skill of result.skills) {
      context.stdout.write(
        `  ${formatCell(skill.name)}\t${formatCell(skill.scope)}\t${skill.bytes} bytes\t${skill.sha256}\t${formatCell(skill.path)}\t${skill.skillId}\n`,
      );
    }
    context.stdout.write(
      `Command templates (${result.commandTemplates.length})\n`,
    );
    for (const template of result.commandTemplates) {
      context.stdout.write(
        `  ${formatCell(template.selector)}\t${formatCell(template.scope)}\t${template.bytes} bytes\t${template.sha256}\t${formatCell(template.path)}\t${template.templateId}\n`,
      );
    }
    context.stdout.write(
      `Configured plugins (${result.configuredPlugins.length})\n`,
    );
    for (const plugin of result.configuredPlugins) {
      context.stdout.write(
        `  ${plugin.pluginId}\t${plugin.required ? "required" : "optional"}\t${plugin.capabilities.join(",")}\t${plugin.manifestSha256}\n`,
      );
    }
    return 0;
  } catch (error) {
    context.stderr.write(`[koda] ${errorMessage(error)}\n`);
    return 1;
  }
}

export async function runExtensionReadCommand(
  kindInput: "skill" | "command-template",
  sourceIdInput: string,
  input: ExtensionCommandInput,
  context: ExtensionCommandContext,
): Promise<number> {
  const kind: ExtensionSourceKind =
    kindInput === "skill" ? "skill" : "command_template";
  const sourceId = sourceIdInput.trim();
  const identity =
    kind === "skill"
      ? skillIdSchema.safeParse(sourceId)
      : commandTemplateIdSchema.safeParse(sourceId);
  if (!identity.success) {
    context.stderr.write(
      `[koda] Source ID does not match extension kind '${kindInput}'.\n`,
    );
    return 2;
  }
  try {
    const result = await createApplication(context).readExtensionSource({
      workspace: input.workspace?.trim() || ".",
      kind,
      sourceId: identity.data,
    });
    context.stdout.write(result.content);
    return 0;
  } catch (error) {
    context.stderr.write(`[koda] ${errorMessage(error)}\n`);
    return 1;
  }
}

function createApplication(context: ExtensionCommandContext): KodaApplication {
  return new KodaApplication({
    environment: context.environment,
    processDirectory: context.processDirectory,
  });
}

function formatCell(value: string): string {
  return value.replace(/[\t\r\n]/gu, " ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
