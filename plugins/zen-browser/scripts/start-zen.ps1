param(
    [Parameter(Mandatory=$true)][string]$ProfilePath,
    [Parameter(Mandatory=$true)][string]$ZenBinary,
    [switch]$Hidden
)
$ErrorActionPreference = 'Stop'
$profileDirectory = (Resolve-Path -LiteralPath $ProfilePath).Path
$binaryPath = (Resolve-Path -LiteralPath $ZenBinary).Path
$profileLock = Join-Path $profileDirectory 'parent.lock'
if (Test-Path -LiteralPath $profileLock) {
    try { $lockProbe = [IO.File]::Open($profileLock, 'Open', 'ReadWrite', 'None'); $lockProbe.Dispose() }
    catch { throw 'This Zen profile is running. Close it normally first; no browser will be killed by this script.' }
}
$launcher = Join-Path (Split-Path -Parent $PSScriptRoot) 'server\launch-zen.mjs'
$launchArgs = @($launcher, '--binary', $binaryPath, '--profile', $profileDirectory)
if ($Hidden) { $launchArgs += '--hidden' }
& node @launchArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
