import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WorkspaceMutationCoordinator,
  WorkspaceMutationError,
} from "@koda/runtime-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let temporaryRoot: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "koda-mutation-lease-"));
  await mkdir(join(temporaryRoot, "repo"));
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("WorkspaceMutationCoordinator", () => {
  it("serializes live writers and releases the lease", async () => {
    const root = join(temporaryRoot, "repo");
    const first = await WorkspaceMutationCoordinator.open(temporaryRoot, root, {
      pollIntervalMs: 2,
      waitTimeoutMs: 200,
    });
    const second = await WorkspaceMutationCoordinator.open(
      temporaryRoot,
      root,
      { pollIntervalMs: 2, waitTimeoutMs: 200 },
    );
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstRun = first.runExclusive(
      new AbortController().signal,
      async () => {
        order.push("first-start");
        await gate;
        order.push("first-end");
      },
    );
    await waitFor(() => order.includes("first-start"));
    const secondRun = second.runExclusive(
      new AbortController().signal,
      async () => {
        order.push("second");
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["first-start"]);
    releaseFirst?.();
    await Promise.all([firstRun, secondRun]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("fails with a bounded busy error and recovers stale owners", async () => {
    const root = join(temporaryRoot, "repo");
    const owner = await WorkspaceMutationCoordinator.open(temporaryRoot, root, {
      pid: 100,
      isProcessAlive: () => true,
      pollIntervalMs: 1,
      waitTimeoutMs: 5,
    });
    let releaseOwner: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const ownerRun = owner.runExclusive(
      new AbortController().signal,
      async () => gate,
    );
    await waitForFile(owner.leasePath);
    const blocked = await WorkspaceMutationCoordinator.open(
      temporaryRoot,
      root,
      {
        pid: 101,
        isProcessAlive: () => true,
        pollIntervalMs: 1,
        waitTimeoutMs: 5,
      },
    );
    await expect(
      blocked.runExclusive(new AbortController().signal, async () => undefined),
    ).rejects.toBeInstanceOf(WorkspaceMutationError);
    releaseOwner?.();
    await ownerRun;

    const staleOwner = await WorkspaceMutationCoordinator.open(
      temporaryRoot,
      root,
      {
        pid: 102,
        isProcessAlive: () => true,
      },
    );
    let releaseStale: (() => void) | undefined;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const staleRun = staleOwner.runExclusive(
      new AbortController().signal,
      async () => staleGate,
    );
    await waitForFile(staleOwner.leasePath);
    const recovery = await WorkspaceMutationCoordinator.open(
      temporaryRoot,
      root,
      { pid: 103, isProcessAlive: (pid) => pid !== 102 },
    );
    await expect(
      recovery.runExclusive(new AbortController().signal, async () => "ok"),
    ).resolves.toBe("ok");
    releaseStale?.();
    await staleRun;
  });

  it("cancels while waiting without running the blocked action", async () => {
    const root = join(temporaryRoot, "repo");
    const owner = await WorkspaceMutationCoordinator.open(temporaryRoot, root, {
      pollIntervalMs: 1,
      waitTimeoutMs: 200,
    });
    let releaseOwner: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const ownerRun = owner.runExclusive(
      new AbortController().signal,
      async () => gate,
    );
    await waitForFile(owner.leasePath);
    const waiter = await WorkspaceMutationCoordinator.open(
      temporaryRoot,
      root,
      { pollIntervalMs: 1, waitTimeoutMs: 200 },
    );
    const controller = new AbortController();
    let ran = false;
    const waiting = waiter.runExclusive(controller.signal, async () => {
      ran = true;
    });
    controller.abort("cancelled lease wait");

    await expect(waiting).rejects.toBeDefined();
    expect(ran).toBe(false);
    releaseOwner?.();
    await ownerRun;
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for condition.");
}

async function waitForFile(path: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw new Error("Timed out waiting for lease file.");
}
