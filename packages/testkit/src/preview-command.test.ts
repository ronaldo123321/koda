import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMacOSPreviewState,
  createMacOSPreviewTarget,
  replaceMacOSPreviewLink,
  resolveMacOSPreviewPaths,
  resolveMacOSPreviewTargetPath,
  writeMacOSPreviewState,
} from "@koda/distribution";
import {
  defaultMacOSPreviewPaths,
  inspectMacOSPreview,
  uninstallMacOSPreview,
} from "@koda/distribution-app";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("unsigned macOS preview commands", () => {
  it("resolves explicit test roots without using KODA_HOME", () => {
    expect(
      defaultMacOSPreviewPaths({
        homeDirectory: "/Users/tester",
        environment: {
          KODA_PREVIEW_ROOT: "/private/tmp/koda-preview",
          KODA_PREVIEW_BIN_DIR: "/private/tmp/koda-bin",
          KODA_HOME: "/private/tmp/runtime-data",
        },
      }),
    ).toMatchObject({
      root: "/private/tmp/koda-preview",
      binDirectory: "/private/tmp/koda-bin",
    });
  });

  it("reports exact launcher drift without mutating installation state", async () => {
    const fixture = await installedFixture();
    await expect(inspectMacOSPreview(fixture.paths)).resolves.toMatchObject({
      status: "ready",
      active: { identity: fixture.active.identity },
      doctor: "not_run",
      signing: "unsigned_internal_preview",
    });
    await rm(fixture.paths.kodaLauncher);
    await writeFile(fixture.paths.kodaLauncher, "unexpected", "utf8");
    await expect(inspectMacOSPreview(fixture.paths)).resolves.toMatchObject({
      status: "invalid",
      doctor: "not_run",
    });
    expect(
      (await readFile(fixture.paths.state, "utf8")).length,
    ).toBeGreaterThan(0);
  });

  it("fails closed on unknown managed-root content during uninstall", async () => {
    const fixture = await installedFixture();
    await writeFile(join(fixture.paths.root, "unknown.txt"), "retain", "utf8");
    await expect(
      uninstallMacOSPreview({
        paths: fixture.paths,
        confirmed: true,
        token: tokenSequence(),
        now: () => 2,
      }),
    ).rejects.toMatchObject({ code: "KODA_PREVIEW_PATH_INVALID" });
    await expect(
      readFile(join(fixture.paths.root, "unknown.txt"), "utf8"),
    ).resolves.toBe("retain");
  });

  it("uninstalls only preview-owned payloads and preserves runtime data", async () => {
    const fixture = await installedFixture();
    const runtimeData = join(fixture.sandbox, "runtime-data", "threads.jsonl");
    await mkdir(join(fixture.sandbox, "runtime-data"), { recursive: true });
    await writeFile(runtimeData, "preserve", "utf8");
    await expect(
      uninstallMacOSPreview({
        paths: fixture.paths,
        confirmed: true,
        token: tokenSequence(),
        now: () => 2,
      }),
    ).resolves.toMatchObject({ status: "not_installed" });
    await expect(readFile(runtimeData, "utf8")).resolves.toBe("preserve");
    await expect(inspectMacOSPreview(fixture.paths)).resolves.toMatchObject({
      status: "not_installed",
    });
  });
});

async function installedFixture() {
  const sandbox = await mkdtemp(join(tmpdir(), "koda-preview-command-"));
  temporaryDirectories.push(sandbox);
  const paths = resolveMacOSPreviewPaths({
    homeDirectory: sandbox,
    previewRoot: join(sandbox, "preview"),
    binDirectory: join(sandbox, "bin"),
  });
  const active = createMacOSPreviewTarget({
    version: "0.1.0",
    sourceCommit: "a".repeat(40),
    arch: "arm64",
  });
  const activePath = resolveMacOSPreviewTargetPath(paths, active);
  await mkdir(activePath, { recursive: true });
  await writeMacOSPreviewState(
    paths,
    createMacOSPreviewState({
      active,
      previous: null,
      installed: [active],
      updatedAtMs: 1,
    }),
    () => "state",
  );
  await replaceMacOSPreviewLink(paths, "current", active, () => "current");
  await mkdir(paths.binDirectory, { recursive: true });
  await symlink(join(paths.currentLink, "bin", "koda"), paths.kodaLauncher);
  await symlink(
    join(paths.currentLink, "bin", "koda-chat"),
    paths.chatLauncher,
  );
  return { sandbox, paths, active };
}

function tokenSequence(): () => string {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}
