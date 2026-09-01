import { z } from "zod";

import { sha256Schema } from "./contracts.js";

export const EMBEDDED_NODE_VERSION = "22.20.0" as const;
export const NODE_DISTRIBUTION_ORIGIN = "https://nodejs.org/dist" as const;

export const embeddedNodeArtifactSchema = z
  .object({
    version: z.literal(EMBEDDED_NODE_VERSION),
    platform: z.literal("darwin"),
    arch: z.enum(["arm64", "x64"]),
    archive: z
      .string()
      .regex(/^node-v\d+\.\d+\.\d+-darwin-(?:arm64|x64)\.tar\.gz$/),
    sha256: sha256Schema,
  })
  .strict();

export type EmbeddedNodeArtifact = z.infer<typeof embeddedNodeArtifactSchema>;

const ARTIFACTS: Readonly<Record<"arm64" | "x64", EmbeddedNodeArtifact>> = {
  arm64: embeddedNodeArtifactSchema.parse({
    version: EMBEDDED_NODE_VERSION,
    platform: "darwin",
    arch: "arm64",
    archive: `node-v${EMBEDDED_NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: "cc04a76a09f79290194c0646f48fec40354d88969bec467789a5d55dd097f949",
  }),
  x64: embeddedNodeArtifactSchema.parse({
    version: EMBEDDED_NODE_VERSION,
    platform: "darwin",
    arch: "x64",
    archive: `node-v${EMBEDDED_NODE_VERSION}-darwin-x64.tar.gz`,
    sha256: "00df9c5df3e4ec6848c26b70fb47bf96492f342f4bed6b17f12d99b3a45eeecc",
  }),
};

export function embeddedNodeArtifact(
  arch: "arm64" | "x64",
): EmbeddedNodeArtifact {
  return ARTIFACTS[arch];
}

export function embeddedNodeArchiveUrl(
  artifact: EmbeddedNodeArtifact,
  origin = NODE_DISTRIBUTION_ORIGIN,
): string {
  const parsed = embeddedNodeArtifactSchema.parse(artifact);
  return `${origin.replace(/\/$/, "")}/v${parsed.version}/${parsed.archive}`;
}

export function embeddedNodeChecksumsUrl(
  version = EMBEDDED_NODE_VERSION,
  origin = NODE_DISTRIBUTION_ORIGIN,
): string {
  return `${origin.replace(/\/$/, "")}/v${version}/SHASUMS256.txt`;
}

export function parseNodeChecksumInventory(
  inventory: string,
  archive: string,
): string {
  if (Buffer.byteLength(inventory, "utf8") > 1_048_576) {
    throw new Error("Node checksum inventory exceeds the byte limit.");
  }
  let match: string | undefined;
  for (const line of inventory.split(/\r?\n/)) {
    const parsed = /^([0-9a-f]{64})  ([A-Za-z0-9._/-]+)$/.exec(line);
    if (parsed?.[2] !== archive) {
      continue;
    }
    if (match !== undefined) {
      throw new Error("Node checksum inventory contains a duplicate archive.");
    }
    match = parsed[1];
  }
  if (match === undefined) {
    throw new Error(
      "Node checksum inventory does not contain the pinned archive.",
    );
  }
  return sha256Schema.parse(match);
}
