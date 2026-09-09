param([Parameter(Mandatory=$true)][string]$OutputFile, [Parameter(Mandatory=$true)][string]$StopFile)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ZenFocusProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
'@
$samples = [Collections.Generic.List[object]]::new()
$deadline = [DateTime]::UtcNow.AddMinutes(5)
while (-not (Test-Path -LiteralPath $StopFile) -and [DateTime]::UtcNow -lt $deadline) {
    $window = [ZenFocusProbe]::GetForegroundWindow()
    [uint32]$foregroundProcess = 0
    [void][ZenFocusProbe]::GetWindowThreadProcessId($window, [ref]$foregroundProcess)
    $samples.Add([pscustomobject]@{ utc = [DateTime]::UtcNow.ToString('o'); handle = $window.ToInt64(); processId = $foregroundProcess })
    if ($samples.Count -eq 1) { 'ready' | Set-Content -LiteralPath ($OutputFile + '.ready') -Encoding utf8 }
    Start-Sleep -Milliseconds 25
}
$samples | ConvertTo-Json -Depth 3 -Compress | Set-Content -LiteralPath $OutputFile -Encoding utf8
