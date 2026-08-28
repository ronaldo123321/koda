import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  connectPluginStdio,
  type PluginConfiguration,
} from "@koda/plugin-host-node";
import { pluginIdSchema } from "@koda/protocol";
import { afterEach, describe, expect, it } from "vitest";

const server = fileURLToPath(
  new URL("../fixtures/plugin-server.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("stdio plugin connection", () => {
  it("negotiates, calls with an exact definition digest, filters environment, and closes once", async () => {
    const fixture = await createFixture();
    const exitFile = join(fixture, "exited.txt");
    const configuration = pluginConfiguration([], exitFile);
    const connection = await connectPluginStdio(
      configuration,
      {
        PATH: process.env.PATH,
        KODA_PLUGIN_ALLOWED: "allowed-secret",
        KODA_PLUGIN_FORBIDDEN: "must-not-leak",
        KODA_PLUGIN_EXIT_FILE: exitFile,
      },
      new AbortController().signal,
    );
    const initialized = await connection.initialize(
      new AbortController().signal,
    );
    expect(initialized.plugin.version).toBe("1.0.0");
    const definitionSha256 = "a".repeat(64);
    await expect(
      connection.callTool(
        "echo",
        { value: "hello" },
        definitionSha256,
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      echoed: "hello",
      definition_sha256: definitionSha256,
      allowed_secret: "allowed-secret",
      forbidden_present: false,
    });
    await connection.close();
    await connection.close();
    await expectFile(exitFile);
  });

  it("terminates hostile initialization and cancelled calls", async () => {
    const hostileFixture = await createFixture();
    const hostileExit = join(hostileFixture, "hostile-exited.txt");
    const hostile = await connectPluginStdio(
      pluginConfiguration(["--mode=hostile-init"], hostileExit),
      { PATH: process.env.PATH, KODA_PLUGIN_EXIT_FILE: hostileExit },
      new AbortController().signal,
    );
    await expect(
      hostile.initialize(new AbortController().signal),
    ).rejects.toMatchObject({ code: "PLUGIN_PROTOCOL_INVALID" });
    await hostile.close();
    await expectFile(hostileExit);

    const cancelledFixture = await createFixture();
    const cancelledExit = join(cancelledFixture, "cancelled-exited.txt");
    const cancelled = await connectPluginStdio(
      pluginConfiguration(["--mode=hang-call"], cancelledExit),
      { PATH: process.env.PATH, KODA_PLUGIN_EXIT_FILE: cancelledExit },
      new AbortController().signal,
    );
    await cancelled.initialize(new AbortController().signal);
    const controller = new AbortController();
    const call = cancelled.callTool(
      "echo",
      { value: "wait" },
      "b".repeat(64),
      controller.signal,
    );
    controller.abort("cancel fixture call");
    await expect(call).rejects.toMatchObject({
      code: "PLUGIN_CONNECTION_CLOSED",
    });
    await cancelled.close();
    await expectFile(cancelledExit);
  });

  it("forces a plugin that acknowledges shutdown but refuses to exit", async () => {
    const fixture = await createFixture();
    const exitFile = join(fixture, "forced-exited.txt");
    const connection = await connectPluginStdio(
      pluginConfiguration(["--mode=ignore-shutdown"], exitFile, 100),
      { PATH: process.env.PATH, KODA_PLUGIN_EXIT_FILE: exitFile },
      new AbortController().signal,
    );
    await connection.initialize(new AbortController().signal);
    await connection.close();
    await expectFile(exitFile);
  });

  it("rejects unsupported versions and terminates timed-out calls", async () => {
    const versionFixture = await createFixture();
    const versionExit = join(versionFixture, "version-exited.txt");
    const unsupported = await connectPluginStdio(
      pluginConfiguration(["--mode=bad-version"], versionExit),
      { PATH: process.env.PATH, KODA_PLUGIN_EXIT_FILE: versionExit },
      new AbortController().signal,
    );
    await expect(
      unsupported.initialize(new AbortController().signal),
    ).rejects.toMatchObject({ code: "PLUGIN_VERSION_UNSUPPORTED" });
    await unsupported.close();
    await expectFile(versionExit);

    const timeoutFixture = await createFixture();
    const timeoutExit = join(timeoutFixture, "timeout-exited.txt");
    const timedOut = await connectPluginStdio(
      pluginConfiguration(["--mode=hang-call"], timeoutExit, 1_000, 100),
      { PATH: process.env.PATH, KODA_PLUGIN_EXIT_FILE: timeoutExit },
      new AbortController().signal,
    );
    await timedOut.initialize(new AbortController().signal);
    await expect(
      timedOut.callTool(
        "echo",
        { value: "wait" },
        "d".repeat(64),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "PLUGIN_TIMEOUT" });
    await timedOut.close();
    await expectFile(timeoutExit);
  });
});

function pluginConfiguration(
  args: string[],
  exitFile: string,
  shutdownTimeoutMs = 1_000,
  callTimeoutMs = 2_000,
): PluginConfiguration {
  return {
    id: pluginIdSchema.parse("fixture"),
    command: process.execPath,
    args: [server, ...args],
    environmentNames: ["KODA_PLUGIN_ALLOWED", "KODA_PLUGIN_EXIT_FILE"].filter(
      (name) => name !== "KODA_PLUGIN_ALLOWED" || args.length === 0,
    ),
    required: true,
    capabilities: ["command_templates", "skills", "tools"],
    tools: {},
    startupTimeoutMs: 2_000,
    callTimeoutMs,
    shutdownTimeoutMs,
    manifestSha256: "c".repeat(64),
  };
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "koda-plugin-connection-"));
  temporaryDirectories.push(root);
  return root;
}

async function expectFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (true) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${path}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }
}
