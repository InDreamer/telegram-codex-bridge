[CmdletBinding()]
param(
  [string]$Home = $HOME,
  [int]$Limit = 3,
  [ValidateSet("delimited", "lines")]
  [string]$Format = "delimited"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $Home -or -not (Test-Path $Home -PathType Container)) {
  throw "home directory does not exist: $Home"
}

if ($Limit -lt 1) {
  throw "-Limit must be a positive integer"
}

function Get-CanonicalDir {
  param([Parameter(Mandatory = $true)][string]$Path)

  return (Resolve-Path -LiteralPath $Path).Path
}

function Test-ProjectDir {
  param([Parameter(Mandatory = $true)][string]$Path)

  return (
    (Test-Path (Join-Path $Path ".git")) -or
    (Test-Path (Join-Path $Path ".hg")) -or
    (Test-Path (Join-Path $Path ".svn")) -or
    (Test-Path (Join-Path $Path "package.json")) -or
    (Test-Path (Join-Path $Path "pyproject.toml")) -or
    (Test-Path (Join-Path $Path "Cargo.toml")) -or
    (Test-Path (Join-Path $Path "go.mod")) -or
    (Test-Path (Join-Path $Path "Makefile"))
  )
}

function Get-CandidateScore {
  param([Parameter(Mandatory = $true)][string]$Root)

  $score = 0
  foreach ($child in Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue) {
    if (Test-ProjectDir -Path $child.FullName) {
      $score += 1
    }
  }

  if ($score -ge 2) {
    return $score
  }

  return $null
}

function Test-PathsOverlap {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )

  $normalizedLeft = [System.IO.Path]::TrimEndingDirectorySeparator($Left).ToLowerInvariant()
  $normalizedRight = [System.IO.Path]::TrimEndingDirectorySeparator($Right).ToLowerInvariant()

  return (
    $normalizedLeft -eq $normalizedRight -or
    $normalizedLeft.StartsWith("$normalizedRight\") -or
    $normalizedRight.StartsWith("$normalizedLeft\")
  )
}

$preferredNames = @("projects", "work", "workspace", "code", "src", "dev", "repos", "repositories", "git", "github")
$candidates = @()
$seen = New-Object System.Collections.Generic.HashSet[string]([System.StringComparer]::OrdinalIgnoreCase)

function Add-Candidate {
  param([Parameter(Mandatory = $true)][string]$Path)

  try {
    $canonical = Get-CanonicalDir -Path $Path
  } catch {
    return
  }

  if (-not $seen.Add($canonical)) {
    return
  }

  $score = Get-CandidateScore -Root $canonical
  if ($null -ne $score) {
    $script:candidates += [pscustomobject]@{
      Score = $score
      Root = $canonical
    }
  }
}

foreach ($preferredName in $preferredNames) {
  $preferredPath = Join-Path $Home $preferredName
  if (Test-Path $preferredPath -PathType Container) {
    Add-Candidate -Path $preferredPath
  }
}

foreach ($entry in Get-ChildItem -LiteralPath $Home -Directory -ErrorAction SilentlyContinue) {
  Add-Candidate -Path $entry.FullName
}

$selected = @()
foreach ($candidate in ($candidates | Sort-Object @{ Expression = "Score"; Descending = $true }, @{ Expression = "Root"; Descending = $false })) {
  $overlap = $false
  foreach ($selectedRoot in $selected) {
    if (Test-PathsOverlap -Left $candidate.Root -Right $selectedRoot) {
      $overlap = $true
      break
    }
  }

  if (-not $overlap) {
    $selected += $candidate.Root
  }

  if ($selected.Count -ge $Limit) {
    break
  }
}

if ($selected.Count -eq 0) {
  exit 0
}

if ($Format -eq "lines") {
  $selected | ForEach-Object { Write-Output $_ }
  exit 0
}

Write-Output ($selected -join ";")
