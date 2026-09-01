import {
  compareMacOSReleaseMetadata,
  macOSReleaseMetadataSchema,
} from "./release.js";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG_PATTERN = /^v[0-9A-Za-z][0-9A-Za-z._-]{0,126}$/;

export interface RenderHomebrewFormulaOptions {
  readonly arm64Metadata: unknown;
  readonly x64Metadata: unknown;
  readonly repository: string;
  readonly tag: string;
  readonly arm64Url?: string;
  readonly x64Url?: string;
}

export function renderHomebrewFormula(
  options: RenderHomebrewFormulaOptions,
): string {
  if (
    !REPOSITORY_PATTERN.test(options.repository) ||
    !TAG_PATTERN.test(options.tag)
  ) {
    throw new Error("Invalid Homebrew release repository or tag.");
  }
  const arm64 = macOSReleaseMetadataSchema.parse(options.arm64Metadata);
  const x64 = macOSReleaseMetadataSchema.parse(options.x64Metadata);
  compareMacOSReleaseMetadata({
    arm64,
    x64,
    arm64MetadataSha256: "0".repeat(64),
    x64MetadataSha256: "0".repeat(64),
  });
  const releaseRoot = `https://github.com/${options.repository}/releases/download/${options.tag}`;
  const arm64Url = releaseUrl(
    options.arm64Url ?? `${releaseRoot}/${arm64.archive.name}`,
    arm64.archive.name,
  );
  const x64Url = releaseUrl(
    options.x64Url ?? `${releaseRoot}/${x64.archive.name}`,
    x64.archive.name,
  );
  const homepage = `https://github.com/${options.repository}`;

  return `class Koda < Formula
  desc "Local-first coding agent CLI and terminal client"
  homepage ${rubyString(homepage)}
  version ${rubyString(arm64.version)}

  on_arm do
    url ${rubyString(arm64Url)}
    sha256 ${rubyString(arm64.archive.sha256)}
  end

  on_intel do
    url ${rubyString(x64Url)}
    sha256 ${rubyString(x64.archive.sha256)}
  end

  def install
    prefix.install Dir["*"]
  end

  test do
    assert_match "koda #{version}", shell_output("#{bin}/koda --version")
    system bin/"koda", "doctor", "--bundle-only"
  end
end
`;
}

function releaseUrl(value: string, archiveName: string): string {
  if (value.length > 2_048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Invalid Homebrew release URL.");
  }
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "file:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !parsed.pathname.endsWith(`/${archiveName}`)
  ) {
    throw new Error("Invalid Homebrew release URL.");
  }
  return parsed.href;
}

function rubyString(value: string): string {
  return JSON.stringify(value);
}
