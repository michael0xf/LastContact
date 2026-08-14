<#
.SYNOPSIS
Publishes the Luminomyxa book files.

.DESCRIPTION
Increments the viewer version when luminomyxa.html changed, commits the book files,
and pushes the current branch to origin. The text publication date is read by the
viewer from the HTTP Last-Modified header and does not require a version bump.

.EXAMPLE
.\publish-luminomyxa.ps1 -Message "Clarify cockpit controls"

.EXAMPLE
.\publish-luminomyxa.ps1 -DryRun
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string] $Message = "",

    [switch] $BumpViewerVersion,
    [switch] $NoPush,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSCommandPath
$viewerFile = "luminomyxa.html"
$publishFiles = @(
    "Luminamyxa.txt",
    "Description.txt",
    $viewerFile,
    "publish-luminomyxa.ps1",
    "publish-luminomyxa.cmd"
)
$versionPattern = '(?<prefix><div class="viewer-version"(?: data-viewer-version)?>v)(?<version>\d+)(?<suffix></div>)'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)]
        [string[]] $Arguments,

        [switch] $Capture
    )

    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & git @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $savedErrorActionPreference
    }
    $text = (($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine).Trim()

    if ($exitCode -ne 0) {
        if ($text) {
            throw "git $($Arguments -join ' ') failed:`n$text"
        }
        throw "git $($Arguments -join ' ') failed with exit code $exitCode"
    }

    if ($Capture) {
        return $text
    }
    if ($text) {
        Write-Host $text
    }
}

function Get-ViewerVersion {
    param([Parameter(Mandatory = $true)][string] $Html)

    $match = [regex]::Match($Html, $versionPattern)
    if (-not $match.Success) {
        throw "Could not find the viewer version marker in $viewerFile"
    }
    if ([regex]::Matches($Html, $versionPattern).Count -ne 1) {
        throw "Expected exactly one viewer version marker in $viewerFile"
    }

    return [int] $match.Groups["version"].Value
}

function Set-ViewerVersion {
    param(
        [Parameter(Mandatory = $true)][string] $Html,
        [Parameter(Mandatory = $true)][int] $Version
    )

    $match = [regex]::Match($Html, $versionPattern)
    $marker = $match.Groups["prefix"].Value + $Version + $match.Groups["suffix"].Value
    return $Html.Remove($match.Index, $match.Length).Insert($match.Index, $marker)
}

Push-Location $repoRoot
try {
    $actualRoot = Invoke-Git -Arguments @("rev-parse", "--show-toplevel") -Capture
    if ([IO.Path]::GetFullPath($actualRoot) -ne [IO.Path]::GetFullPath($repoRoot)) {
        throw "The script must stay in the repository root."
    }

    $branch = Invoke-Git -Arguments @("branch", "--show-current") -Capture
    if ([string]::IsNullOrWhiteSpace($branch)) {
        throw "Cannot publish from a detached HEAD."
    }

    $stagedBefore = Invoke-Git -Arguments @("diff", "--cached", "--name-only") -Capture
    if (-not [string]::IsNullOrWhiteSpace($stagedBefore)) {
        throw "The index already contains staged changes. Commit or unstage them first."
    }

    Invoke-Git -Arguments @("fetch", "origin", $branch)
    $behind = [int] (Invoke-Git -Arguments @("rev-list", "--count", "HEAD..origin/$branch") -Capture)
    if ($behind -gt 0) {
        throw "Local $branch is behind origin/$branch by $behind commit(s). Pull first."
    }

    $viewerPath = Join-Path $repoRoot $viewerFile
    $currentHtml = [IO.File]::ReadAllText($viewerPath, $utf8NoBom)
    $currentVersion = Get-ViewerVersion -Html $currentHtml
    $headHtml = Invoke-Git -Arguments @("show", "HEAD:$viewerFile") -Capture
    $headVersion = Get-ViewerVersion -Html $headHtml
    $viewerState = Invoke-Git -Arguments @("status", "--porcelain=v1", "--", $viewerFile) -Capture
    $viewerChanged = -not [string]::IsNullOrWhiteSpace($viewerState)
    $versionAlreadyBumped = $currentVersion -gt $headVersion
    $shouldBump = $BumpViewerVersion -or ($viewerChanged -and -not $versionAlreadyBumped)
    $nextVersion = $currentVersion

    if ($shouldBump) {
        $nextVersion = [Math]::Max($currentVersion, $headVersion) + 1
    }

    $changes = Invoke-Git -Arguments (@("status", "--short", "--") + $publishFiles) -Capture
    if ([string]::IsNullOrWhiteSpace($changes) -and -not $shouldBump) {
        throw "There are no Luminomyxa changes to publish."
    }

    if ($DryRun) {
        Write-Host "Branch: $branch"
        if ($shouldBump) {
            Write-Host "Viewer version: v$currentVersion -> v$nextVersion"
        }
        elseif ($versionAlreadyBumped) {
            Write-Host "Viewer version: v$currentVersion (already bumped)"
        }
        else {
            Write-Host "Viewer version: v$currentVersion (unchanged)"
        }
        Write-Host "Files:"
        Write-Host $changes
        Write-Host "Dry run: no files, commits, or remote branches were changed."
        return
    }

    if ($shouldBump) {
        $updatedHtml = Set-ViewerVersion -Html $currentHtml -Version $nextVersion
        [IO.File]::WriteAllText($viewerPath, $updatedHtml, $utf8NoBom)
        Write-Host "Viewer version: v$currentVersion -> v$nextVersion"
    }
    elseif ($versionAlreadyBumped) {
        Write-Host "Viewer version: v$currentVersion (already bumped)"
    }

    Invoke-Git -Arguments (@("add", "--") + $publishFiles)
    Invoke-Git -Arguments @("diff", "--cached", "--check")

    $staged = Invoke-Git -Arguments @("diff", "--cached", "--name-only") -Capture
    if ([string]::IsNullOrWhiteSpace($staged)) {
        throw "There are no staged Luminomyxa changes to commit."
    }

    if ([string]::IsNullOrWhiteSpace($Message)) {
        if ($viewerChanged -or $shouldBump) {
            $Message = "Update Luminomyxa viewer to v$nextVersion"
        }
        else {
            $Message = "Update Luminomyxa text"
        }
    }

    Invoke-Git -Arguments @("commit", "-m", $Message)

    if ($NoPush) {
        Write-Host "Committed on $branch; push skipped because -NoPush was specified."
        return
    }

    Invoke-Git -Arguments @("push", "origin", $branch)
    Write-Host "Published $branch successfully."
}
finally {
    Pop-Location
}
