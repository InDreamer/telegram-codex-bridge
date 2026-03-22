[CmdletBinding()]
param(
  [string]$Ref = "master",
  [ValidateSet("branch", "tag")]
  [string]$RefType = "branch"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoOwner = "InDreamer"
$RepoName = "telegram-codex-bridge"
$SkillName = "telegram-codex-linker"
$WorkDir = $null

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

$archiveUrl = Get-ArchiveUrl -Owner $RepoOwner -Name $RepoName -GitRef $Ref -Kind $RefType
$WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ctb-skill-install-" + [System.Guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $WorkDir "source.zip"

try {
  New-Item -ItemType Directory -Path $WorkDir | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri $archiveUrl -OutFile $archivePath
  Expand-Archive -Path $archivePath -DestinationPath $WorkDir -Force

  $sourceDir = Get-ChildItem -Path $WorkDir -Directory | Where-Object { $_.Name -ne "__MACOSX" } | Select-Object -First 1
  if (-not $sourceDir) {
    throw "GitHub archive did not contain a source directory"
  }

  $sourceSkillDir = Join-Path $sourceDir.FullName "skills\$SkillName"
  if (-not (Test-Path (Join-Path $sourceSkillDir "SKILL.md"))) {
    throw "skill bundle not found: $sourceSkillDir"
  }

  $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
  $targetSkillDir = Join-Path $codexHome "skills\$SkillName"
  New-Item -ItemType Directory -Force -Path (Join-Path $codexHome "skills") | Out-Null
  Remove-Item -Recurse -Force $targetSkillDir -ErrorAction SilentlyContinue
  Copy-Item -Recurse -Force $sourceSkillDir $targetSkillDir

  Write-Output "installed Codex skill $SkillName into $targetSkillDir"
  Write-Output "restart Codex to load the new skill"
} finally {
  if ($WorkDir -and (Test-Path $WorkDir)) {
    Remove-Item -Recurse -Force $WorkDir
  }
}
