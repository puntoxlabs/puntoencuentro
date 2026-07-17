param(
  [Parameter(Mandatory=$true)][string]$BundleName,
  [Parameter(Mandatory=$true)][string]$ManifestPath,
  [Parameter(Mandatory=$true)][string]$EslintTargetsPath,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Run-CommandSafely {
  param(
    [string]$Command,
    [string]$OutputFile
  )
  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = "cmd.exe"
  $processInfo.Arguments = "/c $Command"
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = $true
  
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $processInfo
  $process.Start() | Out-Null
  $process.WaitForExit()
  
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $exitCode = $process.ExitCode
  
  $output = "STDOUT:`n$stdout`nSTDERR:`n$stderr`nEXIT_CODE=$exitCode"
  [System.IO.File]::WriteAllText($OutputFile, $output, $utf8NoBom)
  
  return $exitCode
}

Write-Host "Starting build review bundle process..."

$bundleDir = Join-Path $OutputDirectory $BundleName
$zipPath = Join-Path $OutputDirectory "$BundleName.zip"

if (Test-Path $bundleDir) {
  Remove-Item $bundleDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $bundleDir | Out-Null

$stagedFiles = git diff --cached --name-only
if ($stagedFiles) {
  Write-Error "There are staged files. Please unstage them before running this script."
}

Write-Host "Copying files from manifest..."
$manifestFiles = Get-Content $ManifestPath | Where-Object { $_.Trim() -ne "" }
$untrackedPatch = ""

foreach ($file in $manifestFiles) {
  if (Test-Path $file) {
    $targetPath = Join-Path $bundleDir $file
    $targetDir = Split-Path $targetPath -Parent
    if (-not (Test-Path $targetDir)) {
      New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    }
    Copy-Item -Path $file -Destination $targetPath -Force

    # If untracked, add to patch
    $isUntracked = git ls-files --others --exclude-standard $file
    if ($isUntracked) {
      $diffOut = git diff --no-index -- /dev/null $file 2>&1 | Out-String
      $untrackedPatch += $diffOut + "`n"
    }
  } else {
    Write-Error "File not found: $file"
  }
}

if ($untrackedPatch) {
  [System.IO.File]::WriteAllText((Join-Path $bundleDir "untracked.patch"), $untrackedPatch, $utf8NoBom)
}

Write-Host "Running build..."
$buildExitCode = Run-CommandSafely "npm run build" (Join-Path $bundleDir "build-output.txt")
if ($buildExitCode -ne 0) {
  Write-Error "Build failed with exit code $buildExitCode"
}

Write-Host "Running ESLint..."
$eslintTargets = (Get-Content $EslintTargetsPath | Where-Object { $_.Trim() -ne "" }) -join " "
$eslintExitCode = Run-CommandSafely "npx eslint $eslintTargets" (Join-Path $bundleDir "eslint-new-files.txt")
if ($eslintExitCode -ne 0) {
  Write-Error "ESLint failed with exit code $eslintExitCode"
}

Write-Host "Running git checks..."
$diffCheckExitCode = Run-CommandSafely "git diff --check" (Join-Path $bundleDir "git-diff-check.txt")
# ignore CRLF warnings for git diff check, if it only has warnings it's fine unless stdout has trailing whitespaces

Run-CommandSafely "git diff --cached --name-only" (Join-Path $bundleDir "git-diff-cached-name-only.txt") | Out-Null
Run-CommandSafely "git status --porcelain=v1" (Join-Path $bundleDir "git-status.txt") | Out-Null
Run-CommandSafely "git diff" (Join-Path $bundleDir "tracked.patch") | Out-Null

Write-Host "Compressing bundle..."
if (Test-Path $zipPath) {
  Remove-Item $zipPath -Force
}
Compress-Archive -Path $bundleDir -DestinationPath $zipPath -Force

Write-Host "Calculating SHA-256..."
$hash = Get-FileHash -Path $zipPath -Algorithm SHA256
$size = (Get-Item $zipPath).Length
$lastWrite = (Get-Item $zipPath).LastWriteTimeUtc

Write-Host "SHA-256: $($hash.Hash)"
Write-Host "Size: $size bytes"
Write-Host "LastWriteTimeUtc: $lastWrite"

Write-Host "ZIP Contents:"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $zipPath).Path)
foreach ($entry in $zip.Entries) {
  Write-Host $entry.FullName
}
$zip.Dispose()

Write-Host "Bundle created successfully."
