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

Every `v*` release is published by `.github/workflows/release.yml` with
three attestations you can check independently:

- **npm provenance.** The npm tarball is published with
  `npm publish --provenance`, which ties it to the release-tag workflow
  run through a Sigstore bundle on the registry. In a project where
  `babelgate` is installed, verify its signature (and every
  dependency's) with:

  ```sh
  npm audit signatures
  ```

- **Signed container image.** The GHCR image is signed keyless by cosign
  in the same workflow run. Verify a tag (or a digest,
  `ghcr.io/dorrabbkhan/babelgate@sha256:…`) with:

  ```sh
  cosign verify ghcr.io/dorrabbkhan/babelgate:<version> \
    --certificate-identity-regexp '^https://github\.com/dorrabbkhan/babelgate/\.github/workflows/release\.yml@refs/tags/v.*$' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  ```

- **SBOM.** Each GitHub release attaches `babelgate-<version>.cdx.json`,
  a CycloneDX SBOM of the runtime dependencies (devDependencies are
  excluded). The release notes also report the runtime dependency count.

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
