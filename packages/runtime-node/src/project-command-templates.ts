import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import {
  MAX_COMMAND_TEMPLATE_PARAMETERS,
  MAX_PROJECT_COMMAND_TEMPLATES,
  commandTemplateActivationSchema,
  commandTemplateDescriptionSchema,
  commandTemplateIdSchema,
  commandTemplateNameSchema,
  commandTemplateParameterSchema,
  commandTemplateSelectorSchema,
  commandTemplateSnapshotSchema,
  type CommandTemplateActivation,
  type CommandTemplateChange,
  type CommandTemplateParameter,
  type CommandTemplateSnapshot,
} from "@koda/protocol";
import { z } from "zod";

export const MAX_COMMAND_TEMPLATE_FILE_BYTES = 48 * 1_024;
export const MAX_TOTAL_COMMAND_TEMPLATE_BYTES = 192 * 1_024;
export const MAX_COMMAND_TEMPLATE_FRONTMATTER_BYTES = 4 * 1_024;
export const MAX_COMMAND_TEMPLATE_DISCOVERY_DEPTH = 20;
export const MAX_COMMAND_TEMPLATE_INVOCATION_BYTES = 16 * 1_024;
export const MAX_RENDERED_COMMAND_TEMPLATE_BYTES = 64 * 1_024;

export type ProjectCommandTemplateErrorCode =
  | "COMMAND_TEMPLATE_INVALID_LAYOUT"
  | "COMMAND_TEMPLATE_INVALID_FRONTMATTER"
  | "COMMAND_TEMPLATE_INVALID_TYPE"
  | "COMMAND_TEMPLATE_SYMLINK_FORBIDDEN"
  | "COMMAND_TEMPLATE_TOO_LARGE"
  | "COMMAND_TEMPLATE_TOO_MANY"
  | "COMMAND_TEMPLATE_DUPLICATE"
  | "COMMAND_TEMPLATE_INVALID_ENCODING"
  | "COMMAND_TEMPLATE_WORKSPACE_ESCAPE"
  | "COMMAND_TEMPLATE_READ_FAILED"
  | "COMMAND_TEMPLATE_INVALID_INVOCATION"
  | "COMMAND_TEMPLATE_INVALID_ARGUMENT"
  | "COMMAND_TEMPLATE_RENDER_TOO_LARGE";

export class ProjectCommandTemplateError extends Error {
  public constructor(
    public readonly code: ProjectCommandTemplateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectCommandTemplateError";
  }
}

export type ProjectCommandTemplateSource = Omit<
  CommandTemplateSnapshot,
  "parameters"
> & {
  readonly parameters: readonly CommandTemplateParameter[];
  content: string;
  body: string;
};

export interface CommandTemplateInvocation {
  selector: string;
  arguments: Readonly<Record<string, string>>;
}

export interface ExpandedCommandTemplatePrompt {
  prompt: string;
  activation: CommandTemplateActivation;
}

interface CommandTemplateCandidate {
  path: string;
  scope: string;
  fileName: string;
}

export class ProjectCommandTemplateCatalog {
  public readonly sources: readonly ProjectCommandTemplateSource[];
  public readonly totalBytes: number;
  private readonly bySelector: ReadonlyMap<
    string,
    ProjectCommandTemplateSource
  >;

  public constructor(sources: readonly ProjectCommandTemplateSource[]) {
    this.sources = Object.freeze(
      sources.map((source) =>
        Object.freeze({
          ...source,
          parameters: Object.freeze(
            source.parameters.map((parameter) => Object.freeze(parameter)),
          ),
        }),
      ),
    );
    this.totalBytes = this.sources.reduce(
      (total, source) => total + source.bytes,
      0,
    );
    this.bySelector = new Map(
      this.sources.map((source) => [source.selector, source]),
    );
  }

  public get(selector: string): ProjectCommandTemplateSource | undefined {
    return this.bySelector.get(selector);
  }

  public snapshots(): CommandTemplateSnapshot[] {
    return this.sources.map(
      ({ content: _content, body: _body, ...snapshot }) => ({
        ...snapshot,
        parameters: snapshot.parameters.map((parameter) => ({ ...parameter })),
      }),
    );
  }
}

export async function loadProjectCommandTemplates(
  workspaceRoot: string,
): Promise<ProjectCommandTemplateCatalog> {
  const canonicalRoot = await realpath(resolve(workspaceRoot));
  const rootStats = await stat(canonicalRoot);
  if (!rootStats.isDirectory()) {
    throw new ProjectCommandTemplateError(
      "COMMAND_TEMPLATE_READ_FAILED",
      "Project command-template workspace root is not a directory.",
    );
  }

  const candidates = await discoverCommandTemplateCandidates(canonicalRoot);
  if (candidates.length > MAX_PROJECT_COMMAND_TEMPLATES) {
    throw new ProjectCommandTemplateError(
      "COMMAND_TEMPLATE_TOO_MANY",
      `Project contains more than ${MAX_PROJECT_COMMAND_TEMPLATES} command templates.`,
    );
  }

  const sources: ProjectCommandTemplateSource[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    const source = await readCommandTemplateSource(canonicalRoot, candidate);
    totalBytes += source.bytes;
    if (totalBytes > MAX_TOTAL_COMMAND_TEMPLATE_BYTES) {
      throw new ProjectCommandTemplateError(
        "COMMAND_TEMPLATE_TOO_LARGE",
        `Project command templates exceed the ${MAX_TOTAL_COMMAND_TEMPLATE_BYTES}-byte combined limit.`,
      );
    }
    sources.push(source);
  }
  assertNoDuplicateSelectors(sources);
  return new ProjectCommandTemplateCatalog(sources);
}

export function parseCommandTemplateInvocation(
  prompt: string,
): CommandTemplateInvocation | undefined {
  if (!/^\/template(?:[\t ]|$)/u.test(prompt)) {
    return undefined;
  }
  if (
    Buffer.byteLength(prompt, "utf8") > MAX_COMMAND_TEMPLATE_INVOCATION_BYTES
  ) {
    throw invalidInvocation(
      `invocation exceeds ${MAX_COMMAND_TEMPLATE_INVOCATION_BYTES} UTF-8 bytes`,
    );
  }
  const match = /^\/template[\t ]+([^\t \r\n]+)(?:[\t ]+([\s\S]*))?$/u.exec(
    prompt,
  );
  if (match === null) {
    throw invalidInvocation("expected /template <selector> <JSON-object>");
  }
  const selectorResult = commandTemplateSelectorSchema.safeParse(match[1]);
  if (!selectorResult.success) {
    throw invalidInvocation("selector is invalid");
  }
  const rawArguments = (match[2] ?? "").trim();
  const values =
    rawArguments.length === 0
      ? (Object.create(null) as Record<string, string>)
      : parseStringArgumentObject(rawArguments);
  return {
    selector: selectorResult.data,
    arguments: Object.freeze(values),
  };
}

function parseStringArgumentObject(value: string): Record<string, string> {
  let cursor = skipJsonWhitespace(value, 0);
  if (value[cursor] !== "{") {
    throw invalidInvocation("arguments must be a JSON object");
  }
  cursor = skipJsonWhitespace(value, cursor + 1);
  const result = Object.create(null) as Record<string, string>;
  const names = new Set<string>();
  if (value[cursor] === "}") {
    cursor = skipJsonWhitespace(value, cursor + 1);
    if (cursor !== value.length) {
      throw invalidInvocation("arguments must be exactly one JSON object");
    }
    return result;
  }
  while (cursor < value.length) {
    const key = parseJsonString(value, cursor, "argument name");
    cursor = skipJsonWhitespace(value, key.next);
    if (value[cursor] !== ":") {
      throw invalidInvocation("each argument name must be followed by ':'");
    }
    cursor = skipJsonWhitespace(value, cursor + 1);
    if (value[cursor] !== '"') {
      throw invalidInvocation(
        `argument '${bounded(key.value)}' must be a string`,
      );
    }
    const argument = parseJsonString(value, cursor, `argument '${key.value}'`);
    if (names.has(key.value)) {
      throw invalidInvocation(`argument '${bounded(key.value)}' is duplicated`);
    }
    names.add(key.value);
    result[key.value] = argument.value;
    cursor = skipJsonWhitespace(value, argument.next);
    if (value[cursor] === "}") {
      cursor = skipJsonWhitespace(value, cursor + 1);
      if (cursor !== value.length) {
        throw invalidInvocation("arguments must be exactly one JSON object");
      }
      return result;
    }
    if (value[cursor] !== ",") {
      throw invalidInvocation(
        "arguments must use valid JSON object separators",
      );
    }
    cursor = skipJsonWhitespace(value, cursor + 1);
    if (value[cursor] === "}") {
      throw invalidInvocation("arguments must not contain a trailing comma");
    }
  }
  throw invalidInvocation("arguments must be one complete JSON object");
}

function parseJsonString(
  value: string,
  start: number,
  label: string,
): { value: string; next: number } {
  if (value[start] !== '"') {
    throw invalidInvocation(`${label} must be a JSON string`);
  }
  let escaped = false;
  for (let cursor = start + 1; cursor < value.length; cursor += 1) {
    const character = value[cursor]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      const literal = value.slice(start, cursor + 1);
      try {
        const parsed = JSON.parse(literal) as unknown;
        if (typeof parsed !== "string") {
          throw new Error("JSON literal is not a string.");
        }
        return { value: parsed, next: cursor + 1 };
      } catch (error) {
        throw new ProjectCommandTemplateError(
          "COMMAND_TEMPLATE_INVALID_INVOCATION",
          `Command template invocation is invalid: ${label} is not a valid JSON string.`,
          { cause: error },
        );
      }
    }
  }
  throw invalidInvocation(`${label} is not a complete JSON string`);
}

function skipJsonWhitespace(value: string, start: number): number {
  let cursor = start;
  while (
    cursor < value.length &&
    (value[cursor] === " " ||
      value[cursor] === "\t" ||
      value[cursor] === "\r" ||
      value[cursor] === "\n")
  ) {
    cursor += 1;
  }
  return cursor;
}

export function expandProjectCommandTemplatePrompt(
  prompt: string,
  catalog: ProjectCommandTemplateCatalog,
): ExpandedCommandTemplatePrompt | undefined {
  const invocation = parseCommandTemplateInvocation(prompt);
  if (invocation === undefined) {
    return undefined;
  }
  const source = catalog.get(invocation.selector);
  if (source === undefined) {
    const available = catalog.sources
      .map((candidate) => candidate.selector)
      .slice(0, 8)
      .join(", ");
    throw new ProjectCommandTemplateError(
      "COMMAND_TEMPLATE_INVALID_INVOCATION",
      `Command template '${invocation.selector}' is not available.${available.length === 0 ? "" : ` Available selectors: ${available}.`}`,
    );
  }

  const declared = new Map(
    source.parameters.map((parameter) => [parameter.name, parameter]),
  );
  for (const name of Object.keys(invocation.arguments)) {
    if (!declared.has(name)) {
      throw invalidArgument(
        source.selector,
        `argument '${bounded(name)}' is not declared`,
      );
    }
  }
  for (const parameter of source.parameters) {
    const value = invocation.arguments[parameter.name];
    if (value === undefined) {
      if (parameter.required) {
        throw invalidArgument(
          source.selector,
          `required argument '${parameter.name}' is missing`,
        );
      }
      continue;
    }
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > parameter.maxBytes) {
      throw invalidArgument(
        source.selector,
        `argument '${parameter.name}' exceeds its ${parameter.maxBytes}-byte limit`,
      );
    }
  }

  const renderedBody = source.body.replace(
    /\{\{([a-z][a-z0-9_]*)\}\}/gu,
    (_placeholder, name: string) => invocation.arguments[name] ?? "",
  );
  const rendered = [
    `[Koda command template: ${source.selector}; source sha256 ${source.sha256}]`,
    renderedBody,
  ].join("\n");
  const renderedBytes = Buffer.byteLength(rendered, "utf8");
  if (renderedBytes > MAX_RENDERED_COMMAND_TEMPLATE_BYTES) {
    throw new ProjectCommandTemplateError(
      "COMMAND_TEMPLATE_RENDER_TOO_LARGE",
      `Rendered command template '${source.selector}' exceeds the ${MAX_RENDERED_COMMAND_TEMPLATE_BYTES}-byte limit.`,
    );
  }
  const canonicalArguments = JSON.stringify(
    Object.fromEntries(
      Object.entries(invocation.arguments).sort(([left], [right]) =>
        comparePortable(left, right),
      ),
    ),
  );
  return {
    prompt: rendered,
    activation: commandTemplateActivationSchema.parse({
      templateId: source.templateId,
      selector: source.selector,
      templateSha256: source.sha256,
      argumentsSha256: sha256(canonicalArguments),
      renderedSha256: sha256(rendered),
      renderedBytes,
    }),
  };
}

export function diffProjectCommandTemplateSnapshots(
  previous: readonly CommandTemplateSnapshot[],
  current: readonly CommandTemplateSnapshot[],
): CommandTemplateChange[] {
  const previousById = new Map(
    previous.map((source) => [source.templateId, source]),
  );
  const currentById = new Map(
    current.map((source) => [source.templateId, source]),
  );
  const ids = [
    ...new Set([...previousById.keys(), ...currentById.keys()]),
  ].sort();
  const changes: CommandTemplateChange[] = [];
  for (const templateId of ids) {
    const before = previousById.get(templateId);
    const after = currentById.get(templateId);
    if (before === undefined && after !== undefined) {
      changes.push(templateChange(after, "added"));
    } else if (before !== undefined && after === undefined) {
      changes.push(templateChange(before, "removed"));
    } else if (
      before !== undefined &&
      after !== undefined &&
      (before.name !== after.name ||
        before.description !== after.description ||
        before.selector !== after.selector ||
        before.path !== after.path ||
        before.scope !== after.scope ||
        before.bytes !== after.bytes ||
        before.sha256 !== after.sha256 ||
        JSON.stringify(before.parameters) !== JSON.stringify(after.parameters))
    ) {
      changes.push(templateChange(after, "changed"));
    }
  }
  return changes.sort((left, right) =>
    comparePortable(left.selector, right.selector),
  );
}

async function discoverCommandTemplateCandidates(
  root: string,
): Promise<CommandTemplateCandidate[]> {
  const candidates: CommandTemplateCandidate[] = [];

  async function visit(directory: string, scope: string, depth: number) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw commandTemplateReadError(scope, error);
    }
    entries.sort((left, right) => comparePortable(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === ".koda") {
        if (entry.isSymbolicLink()) {
          throw new ProjectCommandTemplateError(
            "COMMAND_TEMPLATE_SYMLINK_FORBIDDEN",
            `Project command-template container cannot be a symlink: ${scopePath(scope, entry.name)}`,
          );
        }
        if (entry.isDirectory()) {
          await discoverScopeCommandTemplates(
            root,
            resolve(directory, entry.name),
            scope,
            candidates,
          );
        }
        continue;
      }
      if (
        entry.isDirectory() &&
        !IGNORED_DIRECTORIES.has(entry.name) &&
        depth < MAX_COMMAND_TEMPLATE_DISCOVERY_DEPTH
      ) {
        await visit(
          resolve(directory, entry.name),
          scopePath(scope, entry.name),
          depth + 1,
        );
      }
    }
  }

  await visit(root, ".", 0);
  return candidates.sort((left, right) => {
    const depth = scopeDepth(left.scope) - scopeDepth(right.scope);
    if (depth !== 0) {
      return depth;
    }
    const scope = comparePortable(left.scope, right.scope);
    return scope !== 0 ? scope : comparePortable(left.fileName, right.fileName);
  });
}

const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);

async function discoverScopeCommandTemplates(
  root: string,
  kodaDirectory: string,
  scope: string,
  candidates: CommandTemplateCandidate[],
): Promise<void> {
  const commandsDirectory = resolve(kodaDirectory, "commands");
  let commandsStats: Stats;
  try {
    commandsStats = await lstat(commandsDirectory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw commandTemplateReadError(scopePath(scope, ".koda/commands"), error);
  }
  if (commandsStats.isSymbolicLink()) {
    throw new ProjectCommandTemplateError(
      "COMMAND_TEMPLATE_SYMLINK_FORBIDDEN",
      `Project command-template directory cannot be a symlink: ${scopePath(scope, ".koda/commands")}`,
    );
  }
  if (!commandsStats.isDirectory()) {
    throw new ProjectCommandTemplateError(
      "COMMAND_TEMPLATE_INVALID_TYPE",
      `Project command-template path is not a directory: ${scopePath(scope, ".koda/commands")}`,
    );
  }
  await assertContained(root, commandsDirectory);

  let entries;
  try {
    entries = await readdir(commandsDirectory, { withFileTypes: true });
  } catch (error) {
    throw commandTemplateReadError(scopePath(scope, ".koda/commands"), error);
  }
  entries.sort((left, right) => comparePortable(left.name, right.name));
  for (const entry of entries) {
    const path = scopePath(scope, `.koda/commands/${entry.name}`);
    if (entry.isSymbolicLink()) {
      throw new ProjectCommandTemplateError(
        "COMMAND_TEMPLATE_SYMLINK_FORBIDDEN",
        `Project command-template source cannot be a symlink: ${path}`,
      );
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      throw new ProjectCommandTemplateError(
        "COMMAND_TEMPLATE_INVALID_LAYOUT",
        `Project command-template entries must be regular .md files: ${path}`,
      );
    }
    const fileName = entry.name.slice(0, -3);
    if (!commandTemplateNameSchema.safeParse(fileName).success) {
      throw new ProjectCommandTemplateError(
        "COMMAND_TEMPLATE_INVALID_LAYOUT",
        `Project command-template file has an invalid name: ${path}`,
      );
    }
    candidates.push({ path, scope, fileName });
    if (candidates.length > MAX_PROJECT_COMMAND_TEMPLATES) {
      throw new ProjectCommandTemplateError(
        "COMMAND_TEMPLATE_TOO_MANY",
        `Project contains more than ${MAX_PROJECT_COMMAND_TEMPLATES} command templates.`,
      );
    }
  }
}

async function readCommandTemplateSource(
  root: string,
  candidate: CommandTemplateCandidate,
): Promise<ProjectCommandTemplateSource> {
  const absolutePath = resolve(root, ...candidate.path.split("/"));
  let pathStats: Stats;
  try {
    pathStats = await lstat(absolutePath);
  } catch (error) {
    throw commandTemplateReadError(candidate.path, error);
  }
  if (pathStats.isSymbolicLink()) {
    throw new ProjectCommandTemplateError(
      "COMMAND_TEMPLATE_SYMLINK_FORBIDDEN",
      `Project command-template source cannot be a symlink: ${candidate.path}`,
    );
  }
  if (!pathStats.isFile()) {
    throw new ProjectCommandTemplateError(
      "COMMAND_TEMPLATE_INVALID_TYPE",
      `Project command-template source is not a regular file: ${candidate.path}`,
    );
  }
  if (pathStats.size > MAX_COMMAND_TEMPLATE_FILE_BYTES) {
    throw commandTemplateTooLarge(candidate.path);
  }
  await assertContained(root, absolutePath);

  let handle;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const openedStats = await handle.stat();
    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino
    ) {
      throw new ProjectCommandTemplateError(
        "COMMAND_TEMPLATE_READ_FAILED",
        `Project command template changed while opening: ${candidate.path}`,
      );
    }
    if (openedStats.size > MAX_COMMAND_TEMPLATE_FILE_BYTES) {
      throw commandTemplateTooLarge(candidate.path);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_COMMAND_TEMPLATE_FILE_BYTES) {
      throw commandTemplateTooLarge(candidate.path);
    }
    if (bytes.includes(0)) {
      throw new ProjectCommandTemplateError(
        "COMMAND_TEMPLATE_INVALID_ENCODING",
        `Project command template appears to be binary: ${candidate.path}`,
      );
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new ProjectCommandTemplateError(
        "COMMAND_TEMPLATE_INVALID_ENCODING",
        `Project command template is not valid UTF-8: ${candidate.path}`,
        { cause: error },
      );
    }
    const frontmatter = parseCommandTemplateFrontmatter(
      candidate.path,
      candidate.fileName,
      content,
    );
    const selector =
      candidate.scope === "."
        ? frontmatter.name
        : `${candidate.scope}/${frontmatter.name}`;
    const selectorResult = commandTemplateSelectorSchema.safeParse(selector);
    if (!selectorResult.success) {
      throw new ProjectCommandTemplateError(
        "COMMAND_TEMPLATE_INVALID_LAYOUT",
        `Project command-template scope cannot form a portable selector: ${candidate.path}`,
      );
    }
    const templateId = commandTemplateIdSchema.parse(
      `command-template:${createHash("sha256")
        .update(`${candidate.path}\0${candidate.scope}\0${frontmatter.name}`)
        .digest("hex")}`,
    );
    const snapshot = commandTemplateSnapshotSchema.parse({
      templateId,
      name: frontmatter.name,
      description: frontmatter.description,
      selector: selectorResult.data,
      path: candidate.path,
      scope: candidate.scope,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      parameters: frontmatter.parameters,
    });
    return { ...snapshot, content, body: frontmatter.body };
  } catch (error) {
    if (error instanceof ProjectCommandTemplateError) {
      throw error;
    }
    if (isNodeError(error, "ELOOP")) {
      throw new ProjectCommandTemplateError(
        "COMMAND_TEMPLATE_SYMLINK_FORBIDDEN",
        `Project command-template source cannot be a symlink: ${candidate.path}`,
        { cause: error },
      );
    }
    throw commandTemplateReadError(candidate.path, error);
  } finally {
    await handle?.close();
  }
}

function parseCommandTemplateFrontmatter(
  path: string,
  fileName: string,
  content: string,
): {
  name: string;
  description: string;
  parameters: CommandTemplateParameter[];
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/u.exec(content);
  if (match === null) {
    throw invalidFrontmatter(
      path,
      "expected one delimited frontmatter block and a non-empty body",
    );
  }
  const header = match[1] ?? "";
  const body = match[2] ?? "";
  if (
    Buffer.byteLength(header, "utf8") > MAX_COMMAND_TEMPLATE_FRONTMATTER_BYTES
  ) {
    throw invalidFrontmatter(
      path,
      `frontmatter exceeds ${MAX_COMMAND_TEMPLATE_FRONTMATTER_BYTES} bytes`,
    );
  }
  if (body.trim().length === 0) {
    throw invalidFrontmatter(path, "body must not be empty");
  }
  const values = new Map<string, string>();
  for (const [index, line] of header.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    const field = /^(name|description|parameters):[ \t]*(.*)$/u.exec(line);
    if (field === null) {
      throw invalidFrontmatter(
        path,
        `unsupported field syntax on line ${index + 2}`,
      );
    }
    const key = field[1]!;
    if (values.has(key)) {
      throw invalidFrontmatter(path, `field '${key}' is duplicated`);
    }
    values.set(key, field[2] ?? "");
  }
  const nameResult = commandTemplateNameSchema.safeParse(
    parseFrontmatterScalar(path, "name", values.get("name") ?? ""),
  );
  if (!nameResult.success) {
    throw invalidFrontmatter(path, "name is missing or invalid");
  }
  if (nameResult.data !== fileName) {
    throw invalidFrontmatter(
      path,
      `name '${nameResult.data}' must match file '${fileName}.md'`,
    );
  }
  const descriptionResult = commandTemplateDescriptionSchema.safeParse(
    parseFrontmatterScalar(
      path,
      "description",
      values.get("description") ?? "",
    ),
  );
  if (!descriptionResult.success) {
    throw invalidFrontmatter(path, "description is missing or invalid");
  }
  const parameters = parseParameters(path, values.get("parameters") ?? "[]");
  validatePlaceholders(path, body, parameters);
  return {
    name: nameResult.data,
    description: descriptionResult.data,
    parameters,
    body,
  };
}

const manifestParameterSchema = z
  .object({
    name: z.unknown(),
    description: z.unknown(),
    type: z.unknown(),
    required: z.unknown(),
    max_bytes: z.unknown(),
  })
  .strict();

function parseParameters(
  path: string,
  rawValue: string,
): CommandTemplateParameter[] {
  let value: unknown;
  try {
    value = JSON.parse(rawValue.trim()) as unknown;
  } catch (error) {
    throw new ProjectCommandTemplateError(
      "COMMAND_TEMPLATE_INVALID_FRONTMATTER",
      `Project command-template frontmatter is invalid at ${path}: parameters must be a single-line JSON array.`,
      { cause: error },
    );
  }
  if (!Array.isArray(value) || value.length > MAX_COMMAND_TEMPLATE_PARAMETERS) {
    throw invalidFrontmatter(
      path,
      `parameters must be an array with at most ${MAX_COMMAND_TEMPLATE_PARAMETERS} entries`,
    );
  }
  const parameters: CommandTemplateParameter[] = [];
  const names = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const manifest = manifestParameterSchema.safeParse(entry);
    if (!manifest.success) {
      throw invalidFrontmatter(
        path,
        `parameter ${index + 1} has invalid fields`,
      );
    }
    const parsed = commandTemplateParameterSchema.safeParse({
      name: manifest.data.name,
      description: manifest.data.description,
      type: manifest.data.type,
      required: manifest.data.required,
      maxBytes: manifest.data.max_bytes,
    });
    if (!parsed.success) {
      throw invalidFrontmatter(path, `parameter ${index + 1} is invalid`);
    }
    if (names.has(parsed.data.name)) {
      throw invalidFrontmatter(
        path,
        `parameter '${parsed.data.name}' is duplicated`,
      );
    }
    names.add(parsed.data.name);
    parameters.push(parsed.data);
  }
  return parameters;
}

function validatePlaceholders(
  path: string,
  body: string,
  parameters: readonly CommandTemplateParameter[],
): void {
  const declared = new Set(parameters.map((parameter) => parameter.name));
  const used = new Set<string>();
  const placeholderPattern = /\{\{([a-z][a-z0-9_]*)\}\}/gu;
  const stripped = body.replace(
    placeholderPattern,
    (_placeholder, name: string) => {
      used.add(name);
      return "";
    },
  );
  if (stripped.includes("{{") || stripped.includes("}}")) {
    throw invalidFrontmatter(path, "body contains an invalid placeholder");
  }
  for (const name of used) {
    if (!declared.has(name)) {
      throw invalidFrontmatter(path, `placeholder '${name}' is not declared`);
    }
  }
  for (const name of declared) {
    if (!used.has(name)) {
      throw invalidFrontmatter(
        path,
        `parameter '${name}' is not used in the body`,
      );
    }
  }
}

function parseFrontmatterScalar(
  path: string,
  key: string,
  rawValue: string,
): string {
  const value = rawValue.trim();
  if (value.startsWith('"') || value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      // Fall through to the bounded error below.
    }
    throw invalidFrontmatter(
      path,
      `field '${key}' has an invalid quoted value`,
    );
  }
  if (value.startsWith("'") || value.endsWith("'")) {
    if (!(value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      throw invalidFrontmatter(
        path,
        `field '${key}' has an invalid quoted value`,
      );
    }
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  if (/^[|>&*!\[{]/u.test(value)) {
    throw invalidFrontmatter(
      path,
      `field '${key}' must use a single-line scalar`,
    );
  }
  return value;
}

function assertNoDuplicateSelectors(
  sources: readonly ProjectCommandTemplateSource[],
): void {
  const selectors = new Set<string>();
  for (const source of sources) {
    if (selectors.has(source.selector)) {
      throw new ProjectCommandTemplateError(
        "COMMAND_TEMPLATE_DUPLICATE",
        `Project command template '${source.selector}' is duplicated.`,
      );
    }
    selectors.add(source.selector);
  }
}

async function assertContained(root: string, path: string): Promise<void> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch (error) {
    throw commandTemplateReadError(portableRelative(root, path), error);
  }
  const relativePath = relative(root, canonicalPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    resolve(root, relativePath) !== canonicalPath
  ) {
    throw new ProjectCommandTemplateError(
      "COMMAND_TEMPLATE_WORKSPACE_ESCAPE",
      `Project command-template path escapes the canonical workspace: ${portableRelative(root, path)}`,
    );
  }
}

function templateChange(
  source: CommandTemplateSnapshot,
  change: CommandTemplateChange["change"],
): CommandTemplateChange {
  return {
    templateId: source.templateId,
    name: source.name,
    selector: source.selector,
    path: source.path,
    scope: source.scope,
    change,
  };
}

function invalidFrontmatter(
  path: string,
  detail: string,
): ProjectCommandTemplateError {
  return new ProjectCommandTemplateError(
    "COMMAND_TEMPLATE_INVALID_FRONTMATTER",
    `Project command-template frontmatter is invalid at ${path}: ${detail}.`,
  );
}

function invalidInvocation(detail: string): ProjectCommandTemplateError {
  return new ProjectCommandTemplateError(
    "COMMAND_TEMPLATE_INVALID_INVOCATION",
    `Command template invocation is invalid: ${detail}.`,
  );
}

function invalidArgument(
  selector: string,
  detail: string,
): ProjectCommandTemplateError {
  return new ProjectCommandTemplateError(
    "COMMAND_TEMPLATE_INVALID_ARGUMENT",
    `Command template '${selector}' has an invalid argument: ${detail}.`,
  );
}

function commandTemplateTooLarge(path: string): ProjectCommandTemplateError {
  return new ProjectCommandTemplateError(
    "COMMAND_TEMPLATE_TOO_LARGE",
    `Project command template exceeds the ${MAX_COMMAND_TEMPLATE_FILE_BYTES}-byte limit: ${path}`,
  );
}

function commandTemplateReadError(
  path: string,
  error: unknown,
): ProjectCommandTemplateError {
  return new ProjectCommandTemplateError(
    "COMMAND_TEMPLATE_READ_FAILED",
    `Project command-template source could not be read: ${path}`,
    { cause: error },
  );
}

function scopeDepth(scope: string): number {
  return scope === "." ? 0 : scope.split("/").length;
}

function scopePath(scope: string, path: string): string {
  return scope === "." ? path : `${scope}/${path}`;
}

function comparePortable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portableRelative(root: string, path: string): string {
  const value = relative(root, path);
  return value.length === 0 ? "." : value.split(sep).join("/");
}

function bounded(value: string): string {
  return value.length <= 128 ? value : `${value.slice(0, 125)}...`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
