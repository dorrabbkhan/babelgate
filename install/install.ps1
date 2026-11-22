# install.ps1 — install a babelgate release binary on Windows (v1.6
# spec §3.2, Task 6, Review Focus 4). Mirrors install.sh; no sudo.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Version <v>] [-Dir <path>]
#
# Downloads babelgate-<v>-win-x64.zip and SHA256SUMS from the GitHub
# release into a temp dir inside the install dir's filesystem, checks
# the zip's SHA-256 against the one SHA256SUMS line for it, verifies
# both Sigstore bundles with cosign when cosign is on PATH — a
# verification failure aborts, never a fallback to "unsigned is
# fine" — and only then moves babelgate.exe into place. Any failure
# leaves the install dir untouched.
#
# BABELGATE_INSTALL_BASE_URL overrides the download base URL (tests);
# BABELGATE_INSTALL_API_URL overrides the releases API base.

param(
  [string]$Version,
  [string]$Dir = (Join-Path $env:LOCALAPPDATA 'babelgate\bin')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# PS5.1 may default to TLS versions GitHub no longer accepts.
if ($PSVersionTable.PSVersion.Major -lt 6) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$Repo = 'dorrabbkhan/babelgate'
$BaseUrl = if ($env:BABELGATE_INSTALL_BASE_URL) {
  $env:BABELGATE_INSTALL_BASE_URL
} else {
  "https://github.com/$Repo/releases/download"
}
$ApiUrl = if ($env:BABELGATE_INSTALL_API_URL) {
  $env:BABELGATE_INSTALL_API_URL
} else {
  "https://api.github.com/repos/$Repo"
}
# Identity of the workflow that signs the binaries (SECURITY.md).
$CosignIdentity = '^https://github\.com/dorrabbkhan/babelgate/\.github/workflows/release\.yml@refs/tags/v.*$'
$CosignIssuer = 'https://token.actions.githubusercontent.com'

function Fail([string]$Message) {
  [Console]::Error.WriteLine("install.ps1: $Message")
  exit 1
}

function Download([string]$Url, [string]$Dest) {
  try {
    Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
  } catch {
    Fail "download failed: $Url"
  }
}

$osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($osArch -ne [System.Runtime.InteropServices.Architecture]::X64) {
  Fail "unsupported architecture: $osArch (only win-x64 binaries are published)"
}
$target = 'win-x64'

if (-not $Version) {
  try {
    $release = Invoke-RestMethod -Uri "$($ApiUrl.TrimEnd('/'))/releases/latest"
  } catch {
    Fail "could not resolve the latest release — pass -Version <v>"
  }
  $Version = $release.tag_name
}
$Version = $Version.TrimStart('v')

$Archive = "babelgate-$Version-$target.zip"
$base = "$($BaseUrl.TrimEnd('/'))/v$Version"

$null = New-Item -ItemType Directory -Force -Path $Dir
$tmp = Join-Path $Dir ('.babelgate-install.' + [System.IO.Path]::GetRandomFileName())
$null = New-Item -ItemType Directory -Path $tmp

try {
  Download "$base/$Archive" (Join-Path $tmp $Archive)
  Download "$base/SHA256SUMS" (Join-Path $tmp 'SHA256SUMS')

  # Integrity: the archive's own SHA256SUMS line (the file also lists
  # the SBOM and the other platforms' archives, not downloaded here).
  $line = Get-Content (Join-Path $tmp 'SHA256SUMS') |
    Where-Object { $_ -match "^[0-9a-f]{64}  $([regex]::Escape($Archive))$" }
  if (-not $line) { Fail "SHA256SUMS has no entry for $Archive" }
  $expected = ($line -split '\s+')[0]
  $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $Archive)).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Fail "SHA-256 mismatch for $Archive (expected $expected, got $actual) — aborted, nothing installed"
  }

  # Provenance: cosign keyless bundles emitted by release.yml on the
  # v* tag (SECURITY.md). A cosign failure aborts; without cosign the
  # signature is not checked and we say so in one line.
  if (Get-Command cosign -ErrorAction SilentlyContinue) {
    Download "$base/SHA256SUMS.sigstore.json" (Join-Path $tmp 'SHA256SUMS.sigstore.json')
    Download "$base/$Archive.sigstore.json" (Join-Path $tmp "$Archive.sigstore.json")
    & cosign verify-blob `
      --bundle (Join-Path $tmp 'SHA256SUMS.sigstore.json') `
      --certificate-identity-regexp $CosignIdentity `
      --certificate-oidc-issuer $CosignIssuer `
      (Join-Path $tmp 'SHA256SUMS') | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Fail 'cosign could not verify SHA256SUMS — aborted, nothing installed'
    }
    & cosign verify-blob `
      --bundle (Join-Path $tmp "$Archive.sigstore.json") `
      --certificate-identity-regexp $CosignIdentity `
      --certificate-oidc-issuer $CosignIssuer `
      (Join-Path $tmp $Archive) | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Fail "cosign could not verify $Archive — aborted, nothing installed"
    }
    Write-Output 'signature verified by cosign (release.yml, keyless)'
  } else {
    Write-Output "note: cosign not found — signature not verified; verify with: cosign verify-blob --bundle $Archive.sigstore.json --certificate-identity-regexp '$CosignIdentity' --certificate-oidc-issuer $CosignIssuer $Archive"
  }

  # Everything checked: extract and move into place. The temp dir
  # lives inside the install dir, so Move-Item is a same-volume rename.
  $extract = Join-Path $tmp 'x'
  Expand-Archive -Path (Join-Path $tmp $Archive) -DestinationPath $extract
  $bin = Join-Path $extract 'babelgate.exe'
  if (-not (Test-Path $bin)) { Fail "$Archive does not contain babelgate.exe" }
  $dest = Join-Path $Dir 'babelgate.exe'
  Move-Item -Force $bin $dest
  Write-Output "installed babelgate $Version to $dest"
  & $dest --version
  if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine("install.ps1: warning: '$dest --version' failed — the binary may not run on this system")
  }

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath -or (($userPath -split ';') -notcontains $Dir)) {
    Write-Output "note: $Dir is not on your user PATH — add it to run 'babelgate' from anywhere"
  }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
