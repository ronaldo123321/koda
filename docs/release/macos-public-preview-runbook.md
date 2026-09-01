# macOS Public Preview Release Runbook

- Scope: MR1A4 credential activation, publication, and acceptance
- Current version/tag: `0.1.0` / `v0.1.0`
- Workflow: `.github/workflows/macos-public-release.yml`
- Status: automation, credential-free GitHub infrastructure, and the scoped Tap
  token secret configured; Apple credentials and first public acceptance pending

## 1. Trust boundary

Ordinary branches and pull requests never receive signing or publication
credentials. They continue to run the unsigned dual-architecture release
contract. Only a push of the exact version tag can start the public workflow,
and all secret-bearing jobs must pass the `macos-public-release` GitHub
Environment rules before secrets become available.

Do not create the tag until every item in sections 2 through 4 is configured.
A failed attempt does not publish an unsigned fallback.

## 2. Apple prerequisites

Prepare one active **Developer ID Application** certificate and export the
identity plus private key as a password-protected PKCS#12 file. Prepare one App
Store Connect API private key authorized to submit software to Apple Notary.
Record its key ID and issuer ID.

The workflow imports the certificate into a random-password ephemeral keychain,
allows only `/usr/bin/codesign` to use it, and deletes the keychain and private
files in an unconditional cleanup step. The App Store Connect private key and
PKCS#12 bytes must never be committed or uploaded as workflow artifacts.

Before encoding the files, verify locally:

```bash
security find-identity -v -p codesigning
openssl pkcs12 -info -in DeveloperID.p12 -noout
```

Encode the two private files as single-line base64 values. Keep the original
files outside the repository.

## 3. Protected GitHub Environment

Create an Environment named `macos-public-release` and configure:

- required reviewer approval;
- deployment branch/tag restriction allowing only protected tags matching
  `v*`;
- no branch deployments;
- the secrets and variables below.

Create a repository ruleset for `v*` tags that restricts tag creation and
deletion to release maintainers. Require the release tag to point at an accepted
`main` commit. The workflow independently checks that the tag name is exactly
`v${KODA_VERSION}` and that the checked-out commit is the tag target.

Configured on 2026-09-01:

- Environment `macos-public-release` (ID `20995695443`) requires approval from
  `ronaldo123321`, does not permit administrator bypass, and permits deployment
  only from tags matching `v*`;
- active repository ruleset
  [`Koda public release tags`](https://github.com/ronaldo123321/koda/settings/rules/22005058)
  targets `refs/tags/v*`, permits only `ronaldo123321` to bypass, and restricts
  creation, update, deletion, and non-fast-forward changes;
- environment secret `KODA_HOMEBREW_TAP_TOKEN` is configured with a fine-grained
  token limited to `ronaldo123321/homebrew-koda`, with repository Contents
  read/write permission and no account permission. GitHub reports only the
  secret name; token validity remains a first-release acceptance check;
- no release tag has been created. Keep `v0.1.0` absent until every secret and
  variable below is configured and re-audited.

### Environment secrets

| Name                             | Value                                                             |
| -------------------------------- | ----------------------------------------------------------------- |
| `KODA_DEVELOPER_ID_P12_BASE64`   | Single-line base64 PKCS#12 bytes                                  |
| `KODA_DEVELOPER_ID_P12_PASSWORD` | PKCS#12 export password                                           |
| `KODA_NOTARY_KEY_BASE64`         | Single-line base64 App Store Connect `.p8` bytes                  |
| `KODA_HOMEBREW_TAP_TOKEN`        | Fine-grained token with Contents write only on the Tap repository |

### Environment variables

| Name                            | Example/meaning                                       |
| ------------------------------- | ----------------------------------------------------- |
| `KODA_DEVELOPER_ID_APPLICATION` | Exact `Developer ID Application: … (TEAMID)` identity |
| `KODA_APPLE_TEAM_ID`            | Ten-character Developer team ID                       |
| `KODA_NOTARY_KEY_ID`            | App Store Connect API key ID                          |
| `KODA_NOTARY_ISSUER_ID`         | App Store Connect issuer UUID                         |
| `KODA_HOMEBREW_TAP_REPOSITORY`  | `owner/homebrew-koda` repository                      |

Never put private values in GitHub variables. Never reuse a broad personal
access token when a repository-scoped fine-grained Tap token is available.

## 4. Tap prerequisites

Create the public Tap repository named by `KODA_HOMEBREW_TAP_REPOSITORY`. It may
start with an empty `Formula/` directory. Protect its default branch while
allowing the release token to update `Formula/koda.rb`.

The public repository
[`ronaldo123321/homebrew-koda`](https://github.com/ronaldo123321/homebrew-koda)
was created on 2026-09-01 with initialized `main` commit
`ffa89160af418f861c8517c5f4d1115aac0eb659`. Environment variable
`KODA_HOMEBREW_TAP_REPOSITORY=ronaldo123321/homebrew-koda` is configured. The
repository-scoped `KODA_HOMEBREW_TAP_TOKEN` environment secret is configured;
its ability to update the Tap must still pass the protected release workflow.

The public workflow first builds and tests the final Formula against the exact
local notarized ZIP, then publishes the immutable GitHub prerelease, and only
then commits the Formula. A retry is safe:

- an existing GitHub release is accepted only if all downloaded asset names,
  `SHA256SUMS`, and every asset digest exactly match the regenerated set;
- an already-matching Formula produces no commit;
- any mismatch fails closed and requires investigation, not asset replacement.

## 5. Release execution

From a clean, synchronized `main` checkout after all ordinary CI and the macOS
Release Contract pass:

```bash
git status --short --branch
git tag -s v0.1.0 -m "Koda v0.1.0 macOS developer preview"
git push origin v0.1.0
```

Approve the `macos-public-release` environment only after confirming the tag
and commit. Do not create a lightweight or unsigned tag for the public preview.

The workflow must prove, in order:

1. exact Koda tag/version and tag target;
2. Node `v22.20.0` signed checksum inventory against the pinned keyring digest,
   commit, and signer fingerprint;
3. native arm64 and Intel builds on matching physical architectures;
4. Developer ID signing of embedded Node, `koda-exec`, and `better-sqlite3` with
   fixed identifiers, Hardened Runtime, and secure timestamps;
5. signed-runtime integrity, standalone smoke, exact ZIP checksum, and
   corruption rejection;
6. Apple Notary `Accepted`, post-submission signature audit, and Gatekeeper
   assessment for every Mach-O file;
7. same-commit dual-architecture contract, Formula smoke, transitive provenance,
   and `SHA256SUMS`;
8. immutable GitHub prerelease and matching public Tap update.

## 6. Clean-machine acceptance

On one clean supported Apple Silicon Mac and one clean supported Intel Mac (or
an Intel Mac reserved for release acceptance), install from the public Tap,
without a source checkout, global Node.js, pnpm, Rust, or Koda path overrides:

```bash
brew tap OWNER/koda
brew install OWNER/koda/koda
koda --version
koda doctor --bundle-only
koda
```

For each architecture, record the release URL, archive SHA-256, macOS version,
hardware architecture, `koda --version`, doctor result, and Gatekeeper result.
Confirm that `which node`, `which pnpm`, and `which cargo` are irrelevant to
Koda startup rather than installing/removing user tools solely for the test.

Run one real turn with a dedicated low-privilege Provider test key. The turn
must stream a complete final answer and perform one approval-gated protected
native command. Do not record the key or environment value in screenshots,
logs, issue text, or evidence documents. Revoke or rotate the test key after
acceptance.

Finally, install the next candidate into a private test Tap or bump/rebuild a
test Formula, run `brew upgrade`, and prove that thread history and other
`KODA_HOME` state survive. Public version `0.1.0` is not considered fully
accepted until both architecture installs and the real-Provider turn pass.

## 7. Failure handling

- Before GitHub Release creation: fix the cause on `main`, bump the version if
  release bytes would change, and create a new protected tag. Never move or
  overwrite a public tag.
- After GitHub Release creation but before Tap update: rerun the failed publish
  job. Its immutable-asset check must pass before retrying the Tap commit.
- If any published byte is wrong: do not replace an asset under the same tag.
  Mark the release as affected, bump the version, and publish a new release.
- If a credential may have appeared in logs or artifacts: stop publication,
  revoke/rotate it first, then audit the workflow run and artifacts.
- If Apple Notary returns `Invalid`: retain the private Notary response only in
  the protected run long enough to diagnose it; do not publish a candidate or
  weaken signature checks to force acceptance.

## 8. Completion record

When the first release passes, update the Mac Release 1A design with:

- tag, source commit, workflow run ID, and run attempt;
- arm64 and Intel archive SHA-256 values;
- Node provenance, code-signature evidence, Notary submission, and public
  provenance document hashes;
- GitHub Release and Tap commit links;
- clean-machine acceptance records for both architectures;
- real-Provider and Homebrew upgrade acceptance results, without secrets.

Until that record exists, MR1A4 automation is implemented but Mac Release 1A
is not declared complete.
