param([Parameter(Mandatory=$true)][int]$CandidatePid,[Parameter(Mandatory=$true)][int]$LauncherPid,[Parameter(Mandatory=$true)][string]$Binary,[Parameter(Mandatory=$true)][string]$ProfilePath)
$ErrorActionPreference = 'Stop'
$process = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $CandidatePid)
if (-not $process -or ($CandidatePid -ne $LauncherPid -and $process.ParentProcessId -ne $LauncherPid) -or
    $process.ExecutablePath -ne $Binary -or $process.CommandLine.IndexOf($ProfilePath, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw 'The browser process is not the instance started by this launcher.'
}
[pscustomobject]@{verified=$true;browserPid=$CandidatePid} | ConvertTo-Json -Compress
