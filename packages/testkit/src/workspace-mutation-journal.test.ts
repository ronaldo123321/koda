import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WorkspaceMutationCoordinator,
  WorkspaceMutationJournalError,
  WorkspaceMutationJournalStore,
  type WorkspaceMutationJournalChange,
} from "@koda/runtime-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let temporaryRoot: string;
let workspaceRoot: string;
let kodaHome: string;
let journal: WorkspaceMutationJournalStore;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "koda-mutation-journal-"));
  workspaceRoot = join(temporaryRoot, "repo");
  kodaHome = join(temporaryRoot, "state");
  await mkdir(workspaceRoot);
  await mkdir(kodaHome);
  journal = await WorkspaceMutationJournalStore.open(kodaHome, workspaceRoot, {
    now: () => "2026-08-28T00:00:00.000Z",
    token: deterministicToken(),
  });
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("WorkspaceMutationJournalStore", () => {
  it("publishes verified private backups before mutation and discards an all-before transaction", async () => {
    await writeFile(join(workspaceRoot, "before.txt"), "before\n", {
      mode: 0o640,
    });
    await chmod(join(workspaceRoot, "before.txt"), 0o640);
    const before = Buffer.from("before\n");
    const after = Buffer.from("after\n");

    const transaction = await journal.begin({
      identity: identity("publish-call"),
      planSha256: hash("publish-plan"),
      changes: [updateChange(0, "before.txt", before, after, 0o640)],
    });

    const manifest = JSON.parse(
      await readFile(join(transaction.directory, "manifest.json"), "utf8"),
    ) as { changes: Array<{ backup: string }> };
    const backupPath = join(transaction.directory, manifest.changes[0]!.backup);
    expect(await readFile(backupPath, "utf8")).toBe("before\n");
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);

    await expect(journal.recoverPending()).resolves.toEqual([
      expect.objectContaining({
        callId: "publish-call",
        status: "not_started",
        paths: ["before.txt"],
      }),
    ]);
    const retainedRoots = await readdir(journal.workspaceDirectory);
    await expect(
      Promise.all(
        retainedRoots.map((entry) =>
          readdir(join(journal.workspaceDirectory, entry)),
        ),
      ),
    ).resolves.toEqual(retainedRoots.map(() => []));
    await expect(
      readFile(join(workspaceRoot, "before.txt"), "utf8"),
    ).resolves.toBe("before\n");
  });

  it("rolls a safely partial create, update, move, and delete transaction back", async () => {
    const updateBefore = Buffer.from("update-before\n");
    const updateAfter = Buffer.from("update-after\n");
    const created = Buffer.from("created\n");
    const moved = Buffer.from("moved\n");
    const deleted = Buffer.from("deleted\n");
    await writeFile(join(workspaceRoot, "update.txt"), updateBefore);
    await writeFile(join(workspaceRoot, "move.txt"), moved);
    await writeFile(join(workspaceRoot, "delete.txt"), deleted);

    await journal.begin({
      identity: identity("partial-call"),
      planSha256: hash("partial-plan"),
      changes: [
        updateChange(0, "update.txt", updateBefore, updateAfter),
        createChange(1, "created.txt", created),
        moveChange(2, "move.txt", "moved.txt", moved),
        deleteChange(3, "delete.txt", deleted),
      ],
    });

    await writeFile(join(workspaceRoot, "update.txt"), updateAfter);
    await writeFile(join(workspaceRoot, "created.txt"), created);
    await link(
      join(workspaceRoot, "move.txt"),
      join(workspaceRoot, "moved.txt"),
    );
    await rm(join(workspaceRoot, "delete.txt"));

    await expect(journal.recoverPending()).resolves.toEqual([
      expect.objectContaining({
        callId: "partial-call",
        status: "rolled_back",
      }),
    ]);
    await expect(
      readFile(join(workspaceRoot, "update.txt"), "utf8"),
    ).resolves.toBe("update-before\n");
    await expect(
      readFile(join(workspaceRoot, "created.txt")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(workspaceRoot, "move.txt"), "utf8"),
    ).resolves.toBe("moved\n");
    await expect(
      readFile(join(workspaceRoot, "moved.txt")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(workspaceRoot, "delete.txt"), "utf8"),
    ).resolves.toBe("deleted\n");
  });

  it("recognizes a fully committed approved after state without rolling it back", async () => {
    const before = Buffer.from("before\n");
    const after = Buffer.from("after\n");
    const created = Buffer.from("created\n");
    await writeFile(join(workspaceRoot, "update.txt"), before);
    await journal.begin({
      identity: identity("committed-call"),
      planSha256: hash("committed-plan"),
      changes: [
        updateChange(0, "update.txt", before, after),
        createChange(1, "created.txt", created),
      ],
    });

    await writeFile(join(workspaceRoot, "update.txt"), after);
    await writeFile(join(workspaceRoot, "created.txt"), created);

    await expect(journal.recoverPending()).resolves.toEqual([
      expect.objectContaining({
        callId: "committed-call",
        status: "committed",
      }),
    ]);
    await expect(
      readFile(join(workspaceRoot, "update.txt"), "utf8"),
    ).resolves.toBe("after\n");
    await expect(
      readFile(join(workspaceRoot, "created.txt"), "utf8"),
    ).resolves.toBe("created\n");
  });

  it("retains divergent files, remains idempotent, and blocks the next coordinated write", async () => {
    const before = Buffer.from("before\n");
    const after = Buffer.from("after\n");
    await writeFile(join(workspaceRoot, "update.txt"), before);
    await journal.begin({
      identity: identity("conflict-call"),
      planSha256: hash("conflict-plan"),
      changes: [updateChange(0, "update.txt", before, after)],
    });
    await writeFile(join(workspaceRoot, "update.txt"), "external edit\n");

    const first = await journal.recoverPending();
    const second = await journal.recoverPending();
    expect(first).toEqual([
      expect.objectContaining({
        callId: "conflict-call",
        status: "conflicted",
      }),
    ]);
    expect(second).toEqual(first);
    await expect(journal.recoverBeforeWrite()).rejects.toMatchObject({
      code: "WORKSPACE_MUTATION_RECOVERY_CONFLICT",
    } satisfies Partial<WorkspaceMutationJournalError>);
    await expect(
      readFile(join(workspaceRoot, "update.txt"), "utf8"),
    ).resolves.toBe("external edit\n");
    expect((await readdir(journal.workspaceDirectory)).length).toBe(1);

    let ran = false;
    const coordinator = await WorkspaceMutationCoordinator.open(
      kodaHome,
      workspaceRoot,
      { beforeAction: async () => void (await journal.recoverBeforeWrite()) },
    );
    await expect(
      coordinator.runExclusive(new AbortController().signal, async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({
      code: "WORKSPACE_MUTATION_RECOVERY_CONFLICT",
    });
    expect(ran).toBe(false);
  });

  it("fails closed when a retained backup is corrupt", async () => {
    const before = Buffer.from("before\n");
    const after = Buffer.from("after\n");
    await writeFile(join(workspaceRoot, "update.txt"), before);
    const transaction = await journal.begin({
      identity: identity("corrupt-call"),
      planSha256: hash("corrupt-plan"),
      changes: [updateChange(0, "update.txt", before, after)],
    });
    await writeFile(
      join(transaction.directory, "backups", "0.before"),
      "forged\n",
    );

    await expect(journal.recoverPending()).rejects.toMatchObject({
      code: "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
    });
    await expect(
      readFile(join(workspaceRoot, "update.txt"), "utf8"),
    ).resolves.toBe("before\n");
  });

  it("retains a recovered receipt until audit acknowledgement and removes its staged candidate", async () => {
    const before = Buffer.from("before\n");
    const after = Buffer.from("after\n");
    const stagedPath = stagedPathFor("update.txt", 0);
    await writeFile(join(workspaceRoot, "update.txt"), before);
    await writeFile(join(workspaceRoot, stagedPath), after);
    await journal.begin({
      identity: identity("receipt-call"),
      planSha256: hash("receipt-plan"),
      changes: [
        {
          ...updateChange(0, "update.txt", before, after),
          stagedPath,
        },
      ],
    });

    const [recovery] = await journal.recoverPending({ retainRecovered: true });
    expect(recovery).toMatchObject({
      callId: "receipt-call",
      status: "not_started",
    });
    await expect(
      readFile(join(workspaceRoot, stagedPath)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await journal.recoverPending({ retainRecovered: true }),
    ).toHaveLength(1);
    await journal.acknowledgeRecovery(recovery!);
    await expect(journal.recoverPending()).resolves.toEqual([]);
  });

  it("treats a symlinked recovery parent as divergent and never follows it", async () => {
    const before = Buffer.from("before\n");
    const after = Buffer.from("after\n");
    const safeDirectory = join(workspaceRoot, "safe");
    const externalDirectory = join(temporaryRoot, "external");
    await mkdir(safeDirectory);
    await mkdir(externalDirectory);
    await writeFile(join(safeDirectory, "file.txt"), before);
    await writeFile(join(externalDirectory, "file.txt"), "external\n");
    await journal.begin({
      identity: identity("symlink-call"),
      planSha256: hash("symlink-plan"),
      changes: [updateChange(0, "safe/file.txt", before, after)],
    });
    await rename(safeDirectory, join(workspaceRoot, "safe-original"));
    await symlink(externalDirectory, safeDirectory, "dir");

    await expect(journal.recoverPending()).resolves.toEqual([
      expect.objectContaining({ callId: "symlink-call", status: "conflicted" }),
    ]);
    await expect(
      readFile(join(externalDirectory, "file.txt"), "utf8"),
    ).resolves.toBe("external\n");
    await expect(
      readFile(join(workspaceRoot, "safe-original", "file.txt"), "utf8"),
    ).resolves.toBe("before\n");
  });

  it("rejects a forged staged-candidate path before publishing a journal", async () => {
    const before = Buffer.from("before\n");
    const after = Buffer.from("after\n");
    await writeFile(join(workspaceRoot, "update.txt"), before);

    await expect(
      journal.begin({
        identity: identity("forged-stage-call"),
        planSha256: hash("forged-stage-plan"),
        changes: [
          {
            ...updateChange(0, "update.txt", before, after),
            stagedPath: "unrelated.txt",
          },
        ],
      }),
    ).rejects.toThrow("operation semantics");
    await expect(journal.recoverPending()).resolves.toEqual([]);
  });
});

function identity(callId: string) {
  return {
    threadId: "journal-thread",
    turnId: "journal-turn",
    callId,
    toolName: "apply_changes",
  };
}

function updateChange(
  index: number,
  path: string,
  before: Buffer,
  after: Buffer,
  mode = 0o644,
): WorkspaceMutationJournalChange {
  return {
    index,
    operation: "update",
    path,
    beforeSha256: hash(before),
    afterSha256: hash(after),
    bytes: after.byteLength,
    beforeMode: mode,
    afterMode: mode,
    beforeBytes: before,
    stagedPath: stagedPathFor(path, index),
  };
}

function createChange(
  index: number,
  path: string,
  after: Buffer,
): WorkspaceMutationJournalChange {
  return {
    index,
    operation: "create",
    path,
    beforeSha256: null,
    afterSha256: hash(after),
    bytes: after.byteLength,
    beforeMode: null,
    afterMode: 0o644,
    stagedPath: stagedPathFor(path, index),
  };
}

function moveChange(
  index: number,
  path: string,
  destination: string,
  before: Buffer,
): WorkspaceMutationJournalChange {
  return {
    index,
    operation: "move",
    path,
    destination,
    beforeSha256: hash(before),
    afterSha256: hash(before),
    bytes: before.byteLength,
    beforeMode: 0o644,
    afterMode: 0o644,
    beforeBytes: before,
  };
}

function deleteChange(
  index: number,
  path: string,
  before: Buffer,
): WorkspaceMutationJournalChange {
  return {
    index,
    operation: "delete",
    path,
    beforeSha256: hash(before),
    afterSha256: null,
    bytes: before.byteLength,
    beforeMode: 0o644,
    afterMode: null,
    beforeBytes: before,
  };
}

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicToken(): () => string {
  let value = 0;
  return () => `token-${value++}`;
}

function stagedPathFor(path: string, index: number): string {
  const separator = path.lastIndexOf("/");
  const directory = separator < 0 ? "" : path.slice(0, separator + 1);
  const filename = path.slice(separator + 1);
  return `${directory}.${filename}.koda-change-00000000-0000-4000-8000-${String(index).padStart(12, "0")}.tmp`;
}
