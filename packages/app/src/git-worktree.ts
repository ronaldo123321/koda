import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitSource {
  root: string;
  commit: string;
  commonDirectory: string;
}

async function git(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    ...(signal === undefined ? {} : { signal }),
  });
  return result.stdout.trim();
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

export async function inspectGitSource(
  workspaceRoot: string,
  kodaHome: string,
  signal?: AbortSignal,
): Promise<GitSource> {
  const root = await realpath(
    await git(workspaceRoot, ["rev-parse", "--show-toplevel"], signal),
  );
  if (root !== (await realpath(workspaceRoot))) {
    throw new Error(
      "Worktree children require the workspace to be the Git repository root.",
    );
  }
  const home = await realpath(kodaHome);
  if (isInside(root, home)) {
    throw new Error(
      "KODA_HOME must be outside the source repository for worktree children.",
    );
  }
  const commit = await git(root, ["rev-parse", "HEAD"], signal);
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) {
    throw new Error("The Git repository has no valid HEAD commit.");
  }
  const common = await git(root, ["rev-parse", "--git-common-dir"], signal);
  return {
    root,
    commit,
    commonDirectory: await realpath(resolve(root, common)),
  };
}

export async function createGitWorktree(
  source: GitSource,
  kodaHome: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const current = await inspectGitSource(source.root, kodaHome, signal);
  if (
    current.commit !== source.commit ||
    current.commonDirectory !== source.commonDirectory
  ) {
    throw new Error(
      "Source Git HEAD or repository identity changed after approval.",
    );
  }
  const directory = join(kodaHome, "worktrees");
  await mkdir(directory, { recursive: true });
  const realDirectory = await realpath(directory);
  if (isInside(source.root, realDirectory)) {
    throw new Error(
      "The worktree directory resolves inside the source repository.",
    );
  }
  const path = join(realDirectory, randomUUID());
  await git(
    source.root,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "worktree",
      "add",
      "--detach",
      path,
      source.commit,
    ],
    signal,
  );
  const actual = await inspectGitSource(path, kodaHome, signal);
  if (
    actual.commit !== source.commit ||
    actual.commonDirectory !== source.commonDirectory
  ) {
    throw new Error(
      "Created worktree does not match the approved source commit.",
    );
  }
  return path;
}

export async function verifyGitWorktree(
  path: string,
  source: GitSource,
  kodaHome: string,
  signal?: AbortSignal,
): Promise<void> {
  const actual = await inspectGitSource(path, kodaHome, signal);
  if (
    actual.root !== (await realpath(path)) ||
    actual.commit !== source.commit ||
    actual.commonDirectory !== source.commonDirectory
  ) {
    throw new Error(
      "Child worktree identity no longer matches its approved source.",
    );
  }
}
