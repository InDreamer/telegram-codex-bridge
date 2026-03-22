[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$TelegramToken,
  [string]$CodexBin = "",
  [string]$ProjectScanRoots = "",
  [string]$Ref = "master",
  [ValidateSet("branch", "tag")]
  [string]$RefType = "branch"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoOwner = "InDreamer"
$RepoName = "telegram-codex-bridge"
$WorkDir = $null

function Test-Command {
  param([Parameter(Mandatory = $true)][string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required"
  }
}

function Test-NodeVersion {
  $nodeVersion = & node -p "process.versions.node"
  if ($LASTEXITCODE -ne 0) {
    throw "failed to read Node version"
  }

  & node -e "const [major, minor, patch] = process.versions.node.split('.').map(Number); process.exit(major > 24 || (major === 24 && (minor > 0 || (minor === 0 && patch >= 0))) ? 0 : 1);"
  if ($LASTEXITCODE -ne 0) {
    throw "Node >=24.0.0 is required; found v$nodeVersion"
  }
}

function Get-ArchiveUrl {
  param(
    [Parameter(Mandatory = $true)][string]$Owner,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$GitRef,
    [Parameter(Mandatory = $true)][string]$Kind
  )

  if ($Kind -eq "branch") {
    return "https://github.com/$Owner/$Name/archive/refs/heads/$GitRef.zip"
  }

  return "https://github.com/$Owner/$Name/archive/refs/tags/$GitRef.zip"
}

Test-Command -Name "node"
Test-Command -Name "npm"
Test-NodeVersion

$archiveUrl = Get-ArchiveUrl -Owner $RepoOwner -Name $RepoName -GitRef $Ref -Kind $RefType
$WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ctb-install-" + [System.Guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $WorkDir "source.zip"

try {
  New-Item -ItemType Directory -Path $WorkDir | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri $archiveUrl -OutFile $archivePath
  Expand-Archive -Path $archivePath -DestinationPath $WorkDir -Force

  $sourceDir = Get-ChildItem -Path $WorkDir -Directory | Where-Object { $_.Name -ne "__MACOSX" } | Select-Object -First 1
  if (-not $sourceDir) {
    throw "GitHub archive did not contain a source directory"
  }

  Push-Location $sourceDir.FullName
  try {
    & npm install
    if ($LASTEXITCODE -ne 0) {
      throw "npm install failed"
    }

    & npm run build
    if ($LASTEXITCODE -ne 0) {
      throw "npm run build failed"
    }

    $installArgs = @("dist/cli.js", "install", "--telegram-token", $TelegramToken)
    if ($CodexBin) {
      $installArgs += @("--codex-bin", $CodexBin)
    }
    if ($ProjectScanRoots) {
      $installArgs += @("--project-scan-roots", $ProjectScanRoots)
    }

    $previousEnv = @{
      CTB_INSTALL_SOURCE_KIND = $env:CTB_INSTALL_SOURCE_KIND
      CTB_INSTALL_SOURCE_REPO_OWNER = $env:CTB_INSTALL_SOURCE_REPO_OWNER
      CTB_INSTALL_SOURCE_REPO_NAME = $env:CTB_INSTALL_SOURCE_REPO_NAME
      CTB_INSTALL_SOURCE_REF = $env:CTB_INSTALL_SOURCE_REF
      CTB_INSTALL_SOURCE_REF_TYPE = $env:CTB_INSTALL_SOURCE_REF_TYPE
    }

    try {
      $env:CTB_INSTALL_SOURCE_KIND = "github-archive"
      $env:CTB_INSTALL_SOURCE_REPO_OWNER = $RepoOwner
      $env:CTB_INSTALL_SOURCE_REPO_NAME = $RepoName
      $env:CTB_INSTALL_SOURCE_REF = $Ref
      $env:CTB_INSTALL_SOURCE_REF_TYPE = $RefType

      & node @installArgs
      if ($LASTEXITCODE -ne 0) {
        throw "bridge install failed"
      }
    } finally {
      foreach ($entry in $previousEnv.GetEnumerator()) {
        if ($null -eq $entry.Value) {
          Remove-Item "Env:$($entry.Key)" -ErrorAction SilentlyContinue
        } else {
          Set-Item "Env:$($entry.Key)" -Value $entry.Value
        }
      }
    }
  } finally {
    Pop-Location
  }
} finally {
  if ($WorkDir -and (Test-Path $WorkDir)) {
    Remove-Item -Recurse -Force $WorkDir
  }
}
