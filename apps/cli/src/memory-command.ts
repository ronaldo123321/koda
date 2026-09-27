import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { ProjectNoteStore } from "@koda/runtime-node";

import { resolveKodaHome } from "./config.js";
import type { TextWriter } from "./console-event-sink.js";

export interface MemoryCommandContext {
  environment: NodeJS.ProcessEnv;
  processDirectory: string;
  stdout: TextWriter;
  stderr: TextWriter;
}

export interface MemoryCommandOptions {
  workspace?: string;
  title?: string;
  body?: string;
  file?: string;
}

export async function runMemoryListCommand(
  options: MemoryCommandOptions,
  context: MemoryCommandContext,
): Promise<number> {
  return withStore(options, context, (store, workspace) => {
    const notes = store.list(workspace);
    if (notes.length === 0) {
      context.stdout.write("No project notes found.\n");
      return;
    }
    context.stdout.write("ID\tREVISION\tUPDATED\tTITLE\n");
    for (const note of notes) {
      context.stdout.write(
        `${note.id}\t${note.revision}\t${note.updatedAt}\t${cell(note.title)}\n`,
      );
    }
  });
}

export async function runMemoryShowCommand(
  id: string,
  options: MemoryCommandOptions,
  context: MemoryCommandContext,
): Promise<number> {
  return withStore(options, context, (store, workspace) => {
    const note = store.get(workspace, id);
    if (note === undefined)
      throw new Error(`Project note '${id}' was not found.`);
    context.stdout.write(
      `ID: ${note.id}\nRevision: ${note.revision}\nTitle: ${note.title}\nUpdated: ${note.updatedAt}\n\n${note.body}${note.body.endsWith("\n") ? "" : "\n"}`,
    );
  });
}

export async function runMemoryAddCommand(
  title: string,
  options: MemoryCommandOptions,
  context: MemoryCommandContext,
): Promise<number> {
  return withStore(options, context, async (store, workspace) => {
    const body = await inputBody(options, context);
    if (body === undefined) throw new Error("Provide --body or --file.");
    const note = store.create({ workspaceRoot: workspace, title, body });
    context.stdout.write(`Created project note ${note.id} (revision 1).\n`);
  });
}

export async function runMemoryEditCommand(
  id: string,
  options: MemoryCommandOptions,
  context: MemoryCommandContext,
): Promise<number> {
  return withStore(options, context, async (store, workspace) => {
    const current = store.get(workspace, id);
    if (current === undefined)
      throw new Error(`Project note '${id}' was not found.`);
    const body = await inputBody(options, context);
    const note = store.update({
      workspaceRoot: workspace,
      id,
      expectedRevision: current.revision,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(body === undefined ? {} : { body }),
    });
    context.stdout.write(
      `Updated project note ${note.id} (revision ${note.revision}).\n`,
    );
  });
}

export async function runMemoryDeleteCommand(
  id: string,
  options: MemoryCommandOptions,
  context: MemoryCommandContext,
): Promise<number> {
  return withStore(options, context, (store, workspace) => {
    const current = store.get(workspace, id);
    if (current === undefined)
      throw new Error(`Project note '${id}' was not found.`);
    store.delete({
      workspaceRoot: workspace,
      id,
      expectedRevision: current.revision,
    });
    context.stdout.write(`Deleted project note ${id}.\n`);
  });
}

export async function runMemorySearchCommand(
  query: string,
  options: MemoryCommandOptions,
  context: MemoryCommandContext,
): Promise<number> {
  return withStore(options, context, (store, workspace) => {
    const matches = store.search(workspace, query);
    if (matches.length === 0) {
      context.stdout.write("No project notes matched.\n");
      return;
    }
    context.stdout.write("ID\tSCORE\tTITLE\tSNIPPET\n");
    for (const match of matches) {
      context.stdout.write(
        `${match.id}\t${match.score}\t${cell(match.title)}\t${cell(match.snippet)}\n`,
      );
    }
  });
}

async function withStore(
  options: MemoryCommandOptions,
  context: MemoryCommandContext,
  operation: (
    store: ProjectNoteStore,
    workspace: string,
  ) => void | Promise<void>,
): Promise<number> {
  let store: ProjectNoteStore | undefined;
  try {
    const workspace = await realpath(
      resolve(context.processDirectory, options.workspace?.trim() || "."),
    );
    store = await ProjectNoteStore.open(resolveKodaHome(context.environment));
    await operation(store, workspace);
    return 0;
  } catch (error) {
    context.stderr.write(`[koda] ${errorMessage(error)}\n`);
    return 1;
  } finally {
    store?.close();
  }
}

async function inputBody(
  options: MemoryCommandOptions,
  context: MemoryCommandContext,
): Promise<string | undefined> {
  if (options.body !== undefined && options.file !== undefined) {
    throw new Error("Use either --body or --file, not both.");
  }
  if (options.file === undefined) return options.body;
  const path = resolve(context.processDirectory, options.file);
  const fileStats = await stat(path);
  if (!fileStats.isFile() || fileStats.size > 8_192) {
    throw new Error("Note source must be a regular file up to 8192 bytes.");
  }
  return readFile(path, "utf8");
}

function cell(value: string): string {
  return value.replace(/[\t\r\n]/gu, " ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
