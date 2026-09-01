import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  canonicalMacOSPreviewActivationJournal,
  canonicalMacOSPreviewState,
  classifyMacOSPreviewRecovery,
  createMacOSPreviewState,
  createMacOSPreviewTarget,
  isManagedPath,
  KodaPreviewError,
  macOSPreviewActivationJournalSchema,
  macOSPreviewStateSchema,
  MacOSPreviewOperationLock,
  parseMacOSPreviewLinkTarget,
  previewIdentity,
  readMacOSPreviewActivationJournal,
  readMacOSPreviewLink,
  readMacOSPreviewState,
  recoverMacOSPreviewActivation,
  removeMacOSPreviewActivationJournal,
  replaceMacOSPreviewLink,
  resolveMacOSPreviewPaths,
  resolveMacOSPreviewTargetPath,
  writeMacOSPreviewActivationJournal,
  writeMacOSPreviewState,
  type MacOSPreviewActivationJournal,
} from "@koda/distribution";
import { afterEach, describe, expect, it } from "vitest";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const OPERATION_ID = "00000000-0000-4000-8000-000000000001";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("unsigned macOS preview installation contracts", () => {
  it("derives stable version identities and managed user-local paths", () => {
    expect(previewIdentity("0.1.0", COMMIT_A)).toBe("0.1.0+aaaaaaaaaaaa");
    const paths = resolveMacOSPreviewPaths({
      homeDirectory: "/Users/tester",
    });
    expect(paths.root).toBe("/Users/tester/.local/share/koda-preview");
    expect(paths.currentLink).toBe(
      "/Users/tester/.local/share/koda-preview/current",
    );
    expect(paths.kodaLauncher).toBe("/Users/tester/.local/bin/koda");

    const target = createMacOSPreviewTarget({
      version: "0.1.0",
      sourceCommit: COMMIT_A,
      arch: "arm64",
    });
    expect(target.relative_path).toBe("versions/0.1.0+aaaaaaaaaaaa");
    expect(resolveMacOSPreviewTargetPath(paths, target)).toBe(
      "/Users/tester/.local/share/koda-preview/versions/0.1.0+aaaaaaaaaaaa",
    );
  });

  it("rejects relative, normalized-away, broad, and overlapping roots", () => {
    for (const input of [
      { homeDirectory: "relative" },
      { homeDirectory: "/" },
      { homeDirectory: "/Users/tester/../tester" },
      {
        homeDirectory: "/Users/tester",
        previewRoot: "/Users/tester/.local",
        binDirectory: "/Users/tester/.local/bin",
      },
    ]) {
      expect(() => resolveMacOSPreviewPaths(input)).toThrow(KodaPreviewError);
    }
  });

  it("recognizes only strict descendants of a managed root", () => {
    const root = resolve("/private/tmp/koda-preview");
    expect(isManagedPath(root, join(root, "versions", "one"))).toBe(true);
    expect(isManagedPath(root, root)).toBe(false);
    expect(isManagedPath(root, resolve(root, "..", "escape"))).toBe(false);
  });

  it("canonicalizes state and rejects mismatched or unsorted projections", () => {
    const active = createMacOSPreviewTarget({
      version: "0.1.0",
      sourceCommit: COMMIT_A,
      arch: "arm64",
    });
    const previous = createMacOSPreviewTarget({
      version: "0.1.0",
      sourceCommit: COMMIT_B,
      arch: "arm64",
    });
    const state = {
      schema_version: 1,
      active,
      previous,
      installed: [active, previous],
      updated_at_ms: 1,
    };
    expect(canonicalMacOSPreviewState(state)).toBe(JSON.stringify(state));
    expect(
      macOSPreviewStateSchema.safeParse({
        ...state,
        installed: [previous, active],
      }).success,
    ).toBe(false);
    expect(
      macOSPreviewStateSchema.safeParse({
        ...state,
        active: { ...active, relative_path: previous.relative_path },
      }).success,
    ).toBe(false);
    expect(
      macOSPreviewStateSchema.safeParse({ ...state, unexpected: true }).success,
    ).toBe(false);
    expect(
      macOSPreviewStateSchema.safeParse({
        ...state,
        active: null,
        previous,
      }).success,
    ).toBe(false);
    expect(
      createMacOSPreviewState({
        active,
        previous,
        installed: [previous, active, active],
        updatedAtMs: 2,
      }).installed.map((target) => target.identity),
    ).toEqual([active.identity, previous.identity]);
  });

  it("classifies exact before, after, and divergent recovery states", () => {
    const before = createMacOSPreviewTarget({
      version: "0.1.0",
      sourceCommit: COMMIT_A,
      arch: "arm64",
    });
    const after = createMacOSPreviewTarget({
      version: "0.1.0",
      sourceCommit: COMMIT_B,
      arch: "arm64",
    });
    const journal: MacOSPreviewActivationJournal = {
      schema_version: 1,
      operation_id: OPERATION_ID,
      operation: "install",
      before,
      before_previous: null,
      after,
      created_at_ms: 1,
    };
    expect(canonicalMacOSPreviewActivationJournal(journal)).toBe(
      JSON.stringify(journal),
    );
    expect(
      classifyMacOSPreviewRecovery({
        journal,
        currentTarget: before.relative_path,
      }),
    ).toEqual({ action: "rollback", target: before });
    expect(
      classifyMacOSPreviewRecovery({
        journal,
        currentTarget: after.relative_path,
      }),
    ).toEqual({ action: "complete", active: after, previous: before });
    expect(
      classifyMacOSPreviewRecovery({
        journal,
        currentTarget: "versions/0.1.0+cccccccccccc",
      }),
    ).toEqual({ action: "conflict" });
  });

  it("requires rollback journals to activate the exact previous target", () => {
    const before = createMacOSPreviewTarget({
      version: "0.1.0",
      sourceCommit: COMMIT_A,
      arch: "x64",
    });
    const after = createMacOSPreviewTarget({
      version: "0.1.0",
      sourceCommit: COMMIT_B,
      arch: "x64",
    });
    expect(
      macOSPreviewActivationJournalSchema.safeParse({
        schema_version: 1,
        operation_id: OPERATION_ID,
        operation: "rollback",
        before,
        before_previous: null,
        after,
        created_at_ms: 1,
      }).success,
    ).toBe(false);
  });

  it("accepts only normalized relative version link targets", () => {
    expect(parseMacOSPreviewLinkTarget(null)).toBeNull();
    expect(parseMacOSPreviewLinkTarget("versions/0.1.0+aaaaaaaaaaaa")).toBe(
      "versions/0.1.0+aaaaaaaaaaaa",
    );
    for (const target of [
      "/absolute",
      "../escape",
      "versions/../escape",
      "versions/nested/value",
    ]) {
      expect(() => parseMacOSPreviewLinkTarget(target)).toThrow();
    }
  });

  it("writes and rereads atomic state, journals, and relative links", async () => {
    const paths = await fixturePaths();
    const active = createMacOSPreviewTarget({
      version: "0.1.0",
      sourceCommit: COMMIT_A,
      arch: "arm64",
    });
    const state = macOSPreviewStateSchema.parse({
      schema_version: 1,
      active,
      previous: null,
      installed: [active],
      updated_at_ms: 1,
    });
    await writeMacOSPreviewState(paths, state, () => "state-token");
    expect(await readMacOSPreviewState(paths)).toEqual(state);
    expect(await readFile(paths.state, "utf8")).toBe(
      `${JSON.stringify(state)}\n`,
    );

    const journal = macOSPreviewActivationJournalSchema.parse({
      schema_version: 1,
      operation_id: OPERATION_ID,
      operation: "install",
      before: null,
      before_previous: null,
      after: active,
      created_at_ms: 1,
    });
    await writeMacOSPreviewActivationJournal(paths, journal, () => "journal");
    expect(await readMacOSPreviewActivationJournal(paths)).toEqual(journal);
    await removeMacOSPreviewActivationJournal(paths);
    expect(await readMacOSPreviewActivationJournal(paths)).toBeNull();

    await replaceMacOSPreviewLink(paths, "current", active, () => "current");
    expect(await readMacOSPreviewLink(paths, "current")).toBe(
      active.relative_path,
    );
    await replaceMacOSPreviewLink(paths, "current", null);
    expect(await readMacOSPreviewLink(paths, "current")).toBeNull();
  });

  it("rejects non-link state at a managed activation path", async () => {
    const paths = await fixturePaths();
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.currentLink, "not a link", "utf8");
    await expect(readMacOSPreviewLink(paths, "current")).rejects.toMatchObject({
      code: "KODA_PREVIEW_STATE_INVALID",
    });
  });

  it("serializes operations, recovers a dead owner, and releases by identity", async () => {
    const paths = await fixturePaths();
    const lock = await MacOSPreviewOperationLock.acquire(paths, "install", {
      pid: 100,
      now: () => 1,
      operationId: () => OPERATION_ID,
      isProcessAlive: () => true,
    });
    await expect(
      MacOSPreviewOperationLock.acquire(paths, "rollback", {
        pid: 200,
        now: () => 2,
        operationId: () => "00000000-0000-4000-8000-000000000002",
        isProcessAlive: () => true,
      }),
    ).rejects.toMatchObject({ code: "KODA_PREVIEW_OPERATION_LOCKED" });
    await lock.release();

    const stale = await MacOSPreviewOperationLock.acquire(paths, "install", {
      pid: 300,
      now: () => 3,
      operationId: () => "00000000-0000-4000-8000-000000000003",
      isProcessAlive: () => false,
    });
    const recovered = await MacOSPreviewOperationLock.acquire(
      paths,
      "rollback",
      {
        pid: 400,
        now: () => 4,
        operationId: sequence(
          "00000000-0000-4000-8000-000000000004",
          "00000000-0000-4000-8000-000000000005",
        ),
        isProcessAlive: () => false,
      },
    );
    await stale.release();
    expect(
      await readFile(join(paths.operationLock, "owner.json"), "utf8"),
    ).toContain("00000000-0000-4000-8000-000000000004");
    await recovered.release();
  });

  it("recovers pre-switch and post-switch activation journals idempotently", async () => {
    const paths = await fixturePaths();
    const before = createMacOSPreviewTarget({
      version: "0.1.0",
      sourceCommit: COMMIT_A,
      arch: "arm64",
    });
    const after = createMacOSPreviewTarget({
      version: "0.1.0",
      sourceCommit: COMMIT_B,
      arch: "arm64",
    });
    const journal = macOSPreviewActivationJournalSchema.parse({
      schema_version: 1,
      operation_id: OPERATION_ID,
      operation: "install",
      before,
      before_previous: null,
      after,
      created_at_ms: 1,
    });
    await replaceMacOSPreviewLink(paths, "current", before, () => "before");
    await writeMacOSPreviewActivationJournal(paths, journal, () => "journal-a");
    const rolledBack = await recoverMacOSPreviewActivation(paths, {
      now: () => 2,
      token: sequence(
        "rollback-previous",
        "rollback-current",
        "rollback-state",
      ),
    });
    expect(rolledBack.action).toBe("rolled_back");
    expect(await readMacOSPreviewLink(paths, "current")).toBe(
      before.relative_path,
    );
    expect(await readMacOSPreviewActivationJournal(paths)).toBeNull();

    await writeMacOSPreviewActivationJournal(paths, journal, () => "journal-b");
    await replaceMacOSPreviewLink(paths, "current", after, () => "after");
    const completed = await recoverMacOSPreviewActivation(paths, {
      now: () => 3,
      token: sequence(
        "complete-previous",
        "complete-current",
        "complete-state",
      ),
    });
    expect(completed.action).toBe("completed");
    expect(await readMacOSPreviewLink(paths, "previous")).toBe(
      before.relative_path,
    );
    expect((await readMacOSPreviewState(paths))?.active).toEqual(after);
    await expect(
      recoverMacOSPreviewActivation(paths, { now: () => 4 }),
    ).resolves.toEqual({ action: "none" });
  });

  it("retains divergent recovery evidence and fails closed", async () => {
    const paths = await fixturePaths();
    const before = createMacOSPreviewTarget({
      version: "0.1.0",
      sourceCommit: COMMIT_A,
      arch: "arm64",
    });
    const after = createMacOSPreviewTarget({
      version: "0.1.0",
      sourceCommit: COMMIT_B,
      arch: "arm64",
    });
    const divergent = createMacOSPreviewTarget({
      version: "0.1.0",
      sourceCommit: "c".repeat(40),
      arch: "arm64",
    });
    await writeMacOSPreviewActivationJournal(
      paths,
      macOSPreviewActivationJournalSchema.parse({
        schema_version: 1,
        operation_id: OPERATION_ID,
        operation: "install",
        before,
        before_previous: null,
        after,
        created_at_ms: 1,
      }),
      () => "journal",
    );
    await replaceMacOSPreviewLink(
      paths,
      "current",
      divergent,
      () => "divergent",
    );
    await expect(recoverMacOSPreviewActivation(paths)).rejects.toMatchObject({
      code: "KODA_PREVIEW_RECOVERY_CONFLICT",
    });
    expect(await readMacOSPreviewActivationJournal(paths)).not.toBeNull();
  });
});

async function fixturePaths() {
  const root = await mkdtemp(join(tmpdir(), "koda-preview-test-"));
  temporaryDirectories.push(root);
  return resolveMacOSPreviewPaths({
    homeDirectory: root,
    previewRoot: join(root, "preview"),
    binDirectory: join(root, "bin"),
  });
}

function sequence(...values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}
