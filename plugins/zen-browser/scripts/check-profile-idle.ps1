param([Parameter(Mandatory=$true)][string]$ProfilePath,[ValidateRange(0,30000)][int]$TimeoutMs=0)
$ErrorActionPreference='Stop'
$profileDirectory=(Resolve-Path -LiteralPath $ProfilePath).Path
$lockPath=Join-Path $profileDirectory 'parent.lock'
$deadline=[DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
do {
    if (-not (Test-Path -LiteralPath $lockPath)) { exit 0 }
    try { $handle=[IO.File]::Open($lockPath,'Open','ReadWrite','None');$handle.Dispose();exit 0 }
    catch { if ([DateTime]::UtcNow -ge $deadline) { throw 'The Zen profile is still in use or not writable. Close it normally before launching; no running browser was terminated.' } }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
throw 'The Zen profile did not become available.'
