import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

import { verifyLocalPluginPackage } from "@koda/plugin-host-node";

import type { TextWriter } from "./console-event-sink.js";

export async function runPluginVerifyCommand(
  directory: string,
  options: { keyId: string; key: string },
  context: { processDirectory: string; stdout: TextWriter; stderr: TextWriter },
): Promise<number> {
  try {
    const key = await open(
      resolve(context.processDirectory, options.key),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let publicKeyPem: string;
    try {
      const info = await key.stat();
      if (!info.isFile() || info.size > 8_192)
        throw new Error("Invalid publisher key file.");
      publicKeyPem = await key.readFile({ encoding: "utf8" });
    } finally {
      await key.close();
    }
    const verified = await verifyLocalPluginPackage(
      resolve(context.processDirectory, directory),
      { keyId: options.keyId, publicKeyPem },
    );
    context.stdout.write(
      `Verified ${verified.id}@${verified.version} (${verified.manifestSha256}) with ${verified.keyId}\n`,
    );
    return 0;
  } catch (error) {
    context.stderr.write(
      `Plugin verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
