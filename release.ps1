# Usage: .\release.ps1 1.2.0
param([Parameter(Mandatory)][string]$Version)

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Host "Version must be X.Y.Z (e.g. 1.2.0)" -ForegroundColor Red
    exit 1
}

# CHANGELOG.md must already have an entry for this version.
$changelog = Get-Content CHANGELOG.md -Raw
if ($changelog -notmatch [regex]::Escape("## v$Version")) {
    Write-Host "No entry for v$Version found in CHANGELOG.md — add it first, then re-run." -ForegroundColor Red
    exit 1
}

# Patch manifest.json version in-place (no reformatting).
$manifest = Get-Content manifest.json -Raw
$patched  = $manifest -replace '"version"\s*:\s*"[^"]*"', "`"version`": `"$Version`""
[System.IO.File]::WriteAllText(
    (Resolve-Path manifest.json).Path,
    $patched,
    (New-Object System.Text.UTF8Encoding $false)
)
Write-Host "manifest.json  →  v$Version" -ForegroundColor Cyan

# Build distributable zip.
$zip = "shiori-v$Version.zip"
if (Test-Path $zip) { Remove-Item $zip }
$include = @(
    'manifest.json','background.js','content.js',
    'library.html','library.js',
    'reader.html','reader.js',
    'options.html','options.js','options.css',
    'popup.html','popup.js',
    'CHANGELOG.md'
)
$paths = $include | Where-Object { Test-Path $_ }
Compress-Archive -Path $paths -DestinationPath $zip
Compress-Archive -Path 'icons','assets' -Update -DestinationPath $zip
Write-Host "$zip built" -ForegroundColor Cyan

# Commit, tag, push.
git add manifest.json CHANGELOG.md
git commit -m "chore: release v$Version"
git tag "v$Version"
git push origin main
git push origin "v$Version"

Write-Host "Released v$Version" -ForegroundColor Green
