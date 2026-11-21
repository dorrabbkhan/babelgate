# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.4.x   | Yes       |
| < 1.4   | No        |

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub: open the
repository's **Security** tab and use **"Report a vulnerability"** (private
vulnerability reporting). Do not open a public issue for a security problem.

Include, where you can:

- the affected version and configuration (your `babelgate.yaml`, or
  `TARGET_API` in env-only mode, with keys removed) and the client you
  used (Claude Code, Codex CLI, an SDK, …),
- steps to reproduce, and
- the impact you believe the issue has.

Never include API keys — yours or anyone else's — in a report.

You can expect an acknowledgement within a few days. If the report is
accepted, a fix will be prepared privately and released before details are
made public.

## Verifying releases

Every `v*` tag triggers `.github/workflows/release.yml`, which builds,
pushes and signs the GHCR image and builds, tests and signs the release
binaries automatically. Publishing to npm and creating the GitHub
release are done by the maintainer by hand; the container image and the
release binaries are the artifacts with a CI-generated attestation:

- **Signed container image.** The GHCR image is signed keyless by cosign
  in the same workflow run. Verify a tag (or a digest,
  `ghcr.io/dorrabbkhan/babelgate@sha256:…`) with:

  ```sh
  cosign verify ghcr.io/dorrabbkhan/babelgate:<version> \
    --certificate-identity-regexp '^https://github\.com/dorrabbkhan/babelgate/\.github/workflows/release\.yml@refs/tags/v.*$' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  ```

- **Signed release binaries.** Each platform archive
  (`babelgate-<version>-<target>.tar.gz`, or `.zip` on Windows) is
  built and tested on its native release runner and signed keyless by
  cosign. The release carries a `SHA256SUMS` file (GNU `sha256sum`
  format, sorted by file name) and one Sigstore bundle
  (`<file>.sigstore.json`) per signed file — every archive and
  `SHA256SUMS` itself. Verify both before installing:

  ```sh
  # integrity — the archive's hash must match SHA256SUMS
  sha256sum --check --ignore-missing SHA256SUMS   # macOS: shasum -a 256 -c

  # provenance — signed by release.yml on a v* tag
  cosign verify-blob \
    --bundle babelgate-<version>-<target>.tar.gz.sigstore.json \
    --certificate-identity-regexp '^https://github\.com/dorrabbkhan/babelgate/\.github/workflows/release\.yml@refs/tags/v.*$' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    babelgate-<version>-<target>.tar.gz
  ```

  The binaries are unsigned by the OS vendors for now (no Apple
  notarization or Windows code signing in v1.6, spec decision D2), so
  macOS Gatekeeper and Windows SmartScreen warn on direct downloads —
  cosign verification above is the trust path; Homebrew avoids the
  quarantine prompt entirely.

- **npm registry signatures.** The npm tarball is published by hand, so
  it carries no provenance bundle (provenance can only be minted by a
  trusted CI builder). npm does add a registry signature to every
  package it serves
  (https://docs.npmjs.com/about-registry-signatures); check
  `babelgate`'s — and every dependency's — with:

  ```sh
  npm audit signatures
  ```

- **SBOM (manual).** The maintainer generates a CycloneDX SBOM of the
  runtime dependencies (devDependencies excluded) and attaches it to
  each GitHub release as `babelgate-<version>.cdx.json`:

  ```sh
  npm ci && npm sbom --sbom-format cyclonedx --omit dev > babelgate-<version>.cdx.json
  ```

  The "Runtime dependencies: <n>" line in the release notes comes from:

  ```sh
  npm ls --omit=dev --all --parseable | tail -n +2 | wc -l
  ```

## Security notes for self-hosters

- `babelgate` forwards upstream provider keys stored in its environment —
  treat `.env` and any process dump as secret material.
- Client access is gated by `PROXY_API_KEY` when set; without it the proxy is
  open — run it only on trusted networks.
- The proxy never logs prompt bodies, completions, or keys. Bodies are kept
  only in an in-memory ring for the `/ui` Inspector, and on disk only with
  `LOG_BODIES=true`. The `/ui` answers only local clients unless
  `UI_ALLOW_REMOTE` is set or `PROXY_API_KEY` is presented. If you find a
  path where one leaks into logs or error messages, that is a bug — report
  it privately as above.
