#!/bin/sh
# install.sh — install a babelgate release binary (v1.6 spec §3.2,
# Task 6, Review Focus 4). POSIX sh; no sudo; never prints secrets.
#
#   sh install.sh [--version <v>] [--dir <path>]
#
# Downloads babelgate-<v>-<target>.tar.gz and SHA256SUMS from the
# GitHub release into a temp dir inside the install dir's filesystem,
# checks the archive's SHA-256 against the one SHA256SUMS line for it
# (SHA256SUMS also lists files we do not download, so a whole-file
# `sha256sum --check` is never run), verifies both Sigstore bundles
# with cosign when cosign is on PATH — a verification failure aborts,
# never a fallback to "unsigned is fine" — and only then moves the
# binary into place. Any failure leaves the install dir untouched.
#
# BABELGATE_INSTALL_BASE_URL overrides the download base URL (tests);
# BABELGATE_INSTALL_API_URL overrides the releases API base (latest
# version lookup).
set -eu

REPO="dorrabbkhan/babelgate"
BASE_URL="${BABELGATE_INSTALL_BASE_URL:-https://github.com/${REPO}/releases/download}"
API_URL="${BABELGATE_INSTALL_API_URL:-https://api.github.com/repos/${REPO}}"
# Identity of the workflow that signs the binaries (SECURITY.md).
COSIGN_IDENTITY='^https://github\.com/dorrabbkhan/babelgate/\.github/workflows/release\.yml@refs/tags/v.*$'
COSIGN_ISSUER='https://token.actions.githubusercontent.com'

fail() {
  echo "install.sh: $*" >&2
  exit 1
}

download() {
  # $1 url, $2 destination file
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1" || fail "download failed: $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1" || fail "download failed: $1"
  else
    fail "need curl or wget to download"
  fi
}

download_stdout() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" || fail "download failed: $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O - "$1" || fail "download failed: $1"
  else
    fail "need curl or wget to download"
  fi
}

version=""
[ -n "${HOME:-}" ] || fail "HOME is not set — pass --dir <path>"
dir="${HOME}/.local/bin"
while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || fail "--version needs a value"
      version="$2"
      shift 2
      ;;
    --dir)
      [ $# -ge 2 ] || fail "--dir needs a value"
      dir="$2"
      shift 2
      ;;
    -h|--help)
      echo "usage: sh install.sh [--version <v>] [--dir <path>]"
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done
dir="${dir%/}"

# Platform detection comes before any temp dir or download so an
# unsupported machine fails fast leaving nothing behind.
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux)  os_part=linux ;;
  Darwin) os_part=darwin ;;
  *)      fail "unsupported operating system: ${os} (on Windows use install.ps1)" ;;
esac
case "$arch" in
  x86_64|amd64)   arch_part=x64 ;;
  arm64|aarch64)  arch_part=arm64 ;;
  *)              fail "unsupported architecture: ${arch}" ;;
esac
target="${os_part}-${arch_part}"

if [ -z "$version" ]; then
  tag=$(download_stdout "${API_URL%/}/releases/latest" \
    | sed -n 's/.*"tag_name"[^"]*"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$tag" ] || fail "could not resolve the latest release — pass --version <v>"
  version="$tag"
fi
version="${version#v}"

archive="babelgate-${version}-${target}.tar.gz"
base="${BASE_URL%/}/v${version}"

mkdir -p "$dir" || fail "cannot create install dir: $dir"
tmp=$(mktemp -d "${dir}/.babelgate-install.XXXXXX") \
  || fail "cannot create a temp dir inside $dir"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
# Map signals to exit so the EXIT trap still removes the temp dir.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

download "${base}/${archive}" "${tmp}/${archive}"
download "${base}/SHA256SUMS" "${tmp}/SHA256SUMS"

# Integrity: the archive's own SHA256SUMS line (the file also lists the
# SBOM and the other platforms' archives, which we do not download).
expected=$(awk -v f="$archive" '$2 == f { print $1 }' "${tmp}/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS has no entry for ${archive}"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "${tmp}/${archive}" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "${tmp}/${archive}" | awk '{ print $1 }')
else
  fail "need sha256sum or shasum to verify the download"
fi
[ "$actual" = "$expected" ] || fail "SHA-256 mismatch for ${archive} (expected ${expected}, got ${actual}) — aborted, nothing installed"

# Provenance: cosign keyless bundles emitted by release.yml on the v*
# tag (SECURITY.md). A cosign failure aborts; without cosign the
# signature is simply not checked and we say so in one line.
if command -v cosign >/dev/null 2>&1; then
  download "${base}/SHA256SUMS.sigstore.json" "${tmp}/SHA256SUMS.sigstore.json"
  download "${base}/${archive}.sigstore.json" "${tmp}/${archive}.sigstore.json"
  cosign verify-blob \
    --bundle "${tmp}/SHA256SUMS.sigstore.json" \
    --certificate-identity-regexp "$COSIGN_IDENTITY" \
    --certificate-oidc-issuer "$COSIGN_ISSUER" \
    "${tmp}/SHA256SUMS" >/dev/null \
    || fail "cosign could not verify SHA256SUMS — aborted, nothing installed"
  cosign verify-blob \
    --bundle "${tmp}/${archive}.sigstore.json" \
    --certificate-identity-regexp "$COSIGN_IDENTITY" \
    --certificate-oidc-issuer "$COSIGN_ISSUER" \
    "${tmp}/${archive}" >/dev/null \
    || fail "cosign could not verify ${archive} — aborted, nothing installed"
  echo "signature verified by cosign (release.yml, keyless)"
else
  echo "note: cosign not found — signature not verified; verify with: cosign verify-blob --bundle ${archive}.sigstore.json --certificate-identity-regexp '${COSIGN_IDENTITY}' --certificate-oidc-issuer ${COSIGN_ISSUER} ${archive}"
fi

# Everything checked: extract and move into place. The temp dir lives
# inside the install dir, so mv is a same-filesystem rename.
mkdir "${tmp}/x"
tar -xzf "${tmp}/${archive}" -C "${tmp}/x" || fail "could not extract ${archive}"
[ -f "${tmp}/x/babelgate" ] || fail "${archive} does not contain babelgate"
chmod 755 "${tmp}/x/babelgate"
dest="${dir}/babelgate"
mv "${tmp}/x/babelgate" "$dest" || fail "could not move babelgate into ${dir}"
echo "installed babelgate ${version} to ${dest}"
if ! "${dest}" --version; then
  echo "install.sh: warning: '${dest} --version' failed — the binary may not run on this system" >&2
fi

case ":${PATH}:" in
  *":${dir}:"*) ;;
  *) echo "note: ${dir} is not on PATH — add it with: export PATH=\"${dir}:\$PATH\"" ;;
esac
