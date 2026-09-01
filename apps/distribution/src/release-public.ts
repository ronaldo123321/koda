import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename } from "node:path";

import {
  KODA_VERSION,
  macOSCodeSignatureEvidenceSchema,
  macOSNotarizationEvidenceSchema,
  macOSPublicReleaseProvenanceSchema,
  macOSReleaseMetadataSchema,
  macOSReleaseSetSchema,
  nodeReleaseProvenanceSchema,
  renderHomebrewFormula,
  type MacOSNotarizationEvidence,
  type MacOSPublicReleaseProvenance,
} from "@koda/distribution";

import {
  assessMacOSGatekeeper,
  auditMacOSCodeSignatures,
} from "./release-security.js";

const PUBLIC_METADATA_MAXIMUM_BYTES = 8 * 1_048_576;

const NOTARY_SUBMISSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function createMacOSNotarizationEvidence(options: {
  readonly responsePath: string;
  readonly archivePath: string;
  readonly releaseMetadataPath: string;
  readonly codeSignatureEvidencePath: string;
  readonly bundleRoot: string;
}): Promise<MacOSNotarizationEvidence> {
  const [responseDocument, archivePath, metadataDocument, signatureDocument] =
    await Promise.all([
      readOpaqueDocument(options.responsePath),
      boundedRegularFile(options.archivePath),
      readJsonDocument(options.releaseMetadataPath, macOSReleaseMetadataSchema),
      readJsonDocument(
        options.codeSignatureEvidencePath,
        macOSCodeSignatureEvidenceSchema,
      ),
    ]);
  const response = parseNotarytoolResponse(responseDocument.content);
  const metadata = metadataDocument.value;
  const signature = signatureDocument.value;
  const archiveMetadata = await stat(archivePath);
  const archiveSha256 = await sha256File(archivePath);
  if (
    basename(archivePath) !== metadata.archive.name ||
    !metadata.archive.name.endsWith(".zip") ||
    archiveMetadata.size !== metadata.archive.bytes ||
    archiveSha256 !== metadata.archive.sha256 ||
    signature.source_commit !== metadata.source_commit ||
    signature.arch !== metadata.arch ||
    signature.archive.name !== metadata.archive.name ||
    signature.archive.bytes !== metadata.archive.bytes ||
    signature.archive.sha256 !== metadata.archive.sha256 ||
    signature.release_metadata_sha256 !== metadataDocument.sha256
  ) {
    throw new Error("Notarization inputs do not describe one signed archive.");
  }
  const auditedFiles = await auditMacOSCodeSignatures({
    bundleRoot: options.bundleRoot,
    architecture: metadata.arch,
    nativeFiles: signature.files.map((file) => file.path),
    teamId: signature.team_id,
  });
  if (JSON.stringify(auditedFiles) !== JSON.stringify(signature.files)) {
    throw new Error(
      "Post-notarization signatures differ from signed evidence.",
    );
  }
  const gatekeeperAssessedFiles = await assessMacOSGatekeeper({
    bundleRoot: options.bundleRoot,
    signedFiles: auditedFiles,
  });
  return macOSNotarizationEvidenceSchema.parse({
    schema_version: 1,
    product: "koda",
    version: KODA_VERSION,
    source_commit: metadata.source_commit,
    platform: "darwin",
    arch: metadata.arch,
    archive: metadata.archive,
    code_signature_evidence_sha256: signatureDocument.sha256,
    submission_id: response.id,
    status: response.status,
    response_sha256: responseDocument.sha256,
    gatekeeper_assessed_files: gatekeeperAssessedFiles,
  });
}

export async function createMacOSPublicReleaseProvenance(options: {
  readonly repository: string;
  readonly tag: string;
  readonly workflowRunId: string;
  readonly workflowRunAttempt: number;
  readonly nodeProvenancePath: string;
  readonly releaseSetPath: string;
  readonly formulaPath: string;
  readonly arm64: PublicArchitecturePaths;
  readonly x64: PublicArchitecturePaths;
}): Promise<MacOSPublicReleaseProvenance> {
  const [node, releaseSet, formula, arm64, x64] = await Promise.all([
    readJsonDocument(options.nodeProvenancePath, nodeReleaseProvenanceSchema),
    readJsonDocument(options.releaseSetPath, macOSReleaseSetSchema),
    readOpaqueDocument(options.formulaPath),
    readPublicArchitecture(options.arm64),
    readPublicArchitecture(options.x64),
  ]);
  const expectedFormula = renderHomebrewFormula({
    arm64Metadata: arm64.metadata,
    x64Metadata: x64.metadata,
    repository: options.repository,
    tag: options.tag,
  });
  if (
    options.tag !== `v${KODA_VERSION}` ||
    arm64.metadata.arch !== "arm64" ||
    x64.metadata.arch !== "x64" ||
    arm64.metadata.source_commit !== x64.metadata.source_commit ||
    releaseSet.value.source_commit !== arm64.metadata.source_commit ||
    releaseSet.value.architectures.arm64.metadata_sha256 !==
      arm64.metadataSha256 ||
    releaseSet.value.architectures.x64.metadata_sha256 !== x64.metadataSha256 ||
    JSON.stringify(releaseSet.value.contract) !==
      JSON.stringify(arm64.metadata.contract) ||
    JSON.stringify(arm64.metadata.contract) !==
      JSON.stringify(x64.metadata.contract) ||
    JSON.stringify(releaseSet.value.architectures.arm64) !==
      JSON.stringify({
        ...arm64.metadata.archive,
        metadata_sha256: arm64.metadataSha256,
      }) ||
    JSON.stringify(releaseSet.value.architectures.x64) !==
      JSON.stringify({
        ...x64.metadata.archive,
        metadata_sha256: x64.metadataSha256,
      }) ||
    node.sha256 !== arm64.signatures.node_provenance_sha256 ||
    node.sha256 !== x64.signatures.node_provenance_sha256 ||
    formula.content.toString("utf8") !== expectedFormula
  ) {
    throw new Error("Public release inputs do not share one provenance root.");
  }
  for (const architecture of [arm64, x64]) {
    if (
      architecture.signatures.arch !== architecture.metadata.arch ||
      architecture.signatures.source_commit !==
        architecture.metadata.source_commit ||
      architecture.signatures.release_metadata_sha256 !==
        architecture.metadataSha256 ||
      JSON.stringify(architecture.signatures.archive) !==
        JSON.stringify(architecture.metadata.archive) ||
      architecture.notarization.source_commit !==
        architecture.metadata.source_commit ||
      architecture.notarization.arch !== architecture.metadata.arch ||
      architecture.notarization.code_signature_evidence_sha256 !==
        architecture.signaturesSha256 ||
      JSON.stringify(architecture.notarization.gatekeeper_assessed_files) !==
        JSON.stringify(
          architecture.signatures.files.map((file) => file.path),
        ) ||
      JSON.stringify(architecture.notarization.archive) !==
        JSON.stringify(architecture.metadata.archive)
    ) {
      throw new Error(
        "Public architecture evidence is not transitively bound.",
      );
    }
  }
  return macOSPublicReleaseProvenanceSchema.parse({
    schema_version: 1,
    product: "koda",
    version: KODA_VERSION,
    tag: options.tag,
    repository: options.repository,
    source_commit: arm64.metadata.source_commit,
    workflow: {
      run_id: options.workflowRunId,
      run_attempt: options.workflowRunAttempt,
    },
    node_provenance_sha256: node.sha256,
    release_set_sha256: releaseSet.sha256,
    formula_sha256: formula.sha256,
    architectures: {
      arm64: publicArchitectureRecord(arm64),
      x64: publicArchitectureRecord(x64),
    },
  });
}

interface PublicArchitecturePaths {
  readonly releaseMetadataPath: string;
  readonly codeSignatureEvidencePath: string;
  readonly notarizationEvidencePath: string;
}

async function readPublicArchitecture(paths: PublicArchitecturePaths) {
  const [metadata, signatures, notarization] = await Promise.all([
    readJsonDocument(paths.releaseMetadataPath, macOSReleaseMetadataSchema),
    readJsonDocument(
      paths.codeSignatureEvidencePath,
      macOSCodeSignatureEvidenceSchema,
    ),
    readJsonDocument(
      paths.notarizationEvidencePath,
      macOSNotarizationEvidenceSchema,
    ),
  ]);
  return {
    metadata: metadata.value,
    metadataSha256: metadata.sha256,
    signatures: signatures.value,
    signaturesSha256: signatures.sha256,
    notarization: notarization.value,
    notarizationSha256: notarization.sha256,
  };
}

function publicArchitectureRecord(
  architecture: Awaited<ReturnType<typeof readPublicArchitecture>>,
) {
  return {
    archive: architecture.metadata.archive,
    release_metadata_sha256: architecture.metadataSha256,
    code_signature_evidence_sha256: architecture.signaturesSha256,
    notarization_evidence_sha256: architecture.notarizationSha256,
  };
}

interface StrictSchema<T> {
  parse(value: unknown): T;
}

async function readJsonDocument<T>(path: string, schema: StrictSchema<T>) {
  const document = await readOpaqueDocument(path);
  return {
    value: schema.parse(
      JSON.parse(document.content.toString("utf8")) as unknown,
    ),
    sha256: document.sha256,
  };
}

function parseNotarytoolResponse(content: Buffer): {
  id: string;
  status: "Accepted";
} {
  const value = JSON.parse(content.toString("utf8")) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    !("status" in value) ||
    typeof value.id !== "string" ||
    !NOTARY_SUBMISSION_ID_PATTERN.test(value.id) ||
    value.status !== "Accepted"
  ) {
    throw new Error("Apple Notary did not return an accepted submission.");
  }
  return { id: value.id, status: "Accepted" };
}

async function readOpaqueDocument(path: string) {
  const canonical = await boundedRegularFile(path);
  const content = await readFile(canonical);
  return {
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

async function boundedRegularFile(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.size < 1 ||
    metadata.size > PUBLIC_METADATA_MAXIMUM_BYTES
  ) {
    throw new Error("Expected a bounded public release file.");
  }
  return realpath(path);
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}
