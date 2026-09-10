param([Parameter(Mandatory=$true)][string]$ProfilePath, [switch]$Apply, [string]$RestoreReceipt)
$ErrorActionPreference = 'Stop'
$profileDirectory = (Resolve-Path -LiteralPath $ProfilePath).Path
$target = Join-Path $profileDirectory 'user.js'
$prefsFile = Join-Path $profileDirectory 'prefs.js'
$prefPattern = '(?m)^user_pref\("remote\.prefs\.recommended", (?:true|false)\);\r?\n?'
$lockFile = Join-Path $profileDirectory 'parent.lock'
if (Test-Path -LiteralPath $lockFile) {
    try { $lockProbe = [IO.File]::Open($lockFile, 'Open', 'ReadWrite', 'None'); $lockProbe.Dispose() }
    catch { throw 'Close the selected Zen profile normally before configuration. No browser will be killed.' }
}
if ($RestoreReceipt) {
    if (-not $Apply) { throw 'Restoring a receipt requires -Apply.' }
    $receipt = Get-Content -LiteralPath $RestoreReceipt -Raw | ConvertFrom-Json
    if ($receipt.profile -ne $profileDirectory -or $receipt.target -ne $target) { throw 'The receipt belongs to another profile.' }
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $receipt.resultHash) { throw 'user.js changed after setup; restore only after reviewing those changes.' }
    if (Test-Path -LiteralPath $prefsFile) {
        $prefsText = [IO.File]::ReadAllText($prefsFile, [Text.UTF8Encoding]::new($false, $true))
        $current = [regex]::Matches($prefsText, $prefPattern)
        if ($current.Count -gt 1) { throw 'The stored preference has duplicate entries; review before restoring.' }
        if ($current.Count -eq 1) {
            $replacement = if ($null -eq $receipt.originalPreference) { '' } else { [string]$receipt.originalPreference }
            $prefsText = [regex]::Replace($prefsText, $prefPattern, [Text.RegularExpressions.MatchEvaluator]{ param($match) $replacement })
        } elseif ($null -ne $receipt.originalPreference) { $prefsText += "`n" + [string]$receipt.originalPreference }
        [IO.File]::WriteAllText($prefsFile, $prefsText, [Text.UTF8Encoding]::new($false))
    }
    # Keeping an empty user.js is intentional when there was no original file.
    # No profile file or directory is deleted.
    [IO.File]::WriteAllBytes($target, [Convert]::FromBase64String($receipt.originalBase64))
    Write-Output 'Restored user.js and the original remote.prefs.recommended value in prefs.js. No browser data was removed.'
    exit 0
}
$original = if (Test-Path -LiteralPath $target) { [IO.File]::ReadAllBytes($target) } else { [byte[]]@() }
$text = [Text.UTF8Encoding]::new($false, $true).GetString($original)
$originalPreference = $null
if (Test-Path -LiteralPath $prefsFile) {
    $matches = [regex]::Matches([IO.File]::ReadAllText($prefsFile, [Text.UTF8Encoding]::new($false, $true)), $prefPattern)
    if ($matches.Count -gt 1) { throw 'The stored preference has duplicate entries; review before setup.' }
    if ($matches.Count -eq 1) { $originalPreference = $matches[0].Value }
}
if ($text -match '(?m)^\s*user_pref\(\s*["'']remote\.prefs\.recommended["'']\s*,\s*false\s*\)\s*;\s*$' -and $text -notmatch '(?m)^\s*user_pref\(\s*["'']remote\.prefs\.recommended["'']\s*,\s*true\s*\)') {
    Write-Output 'This user.js already disables automatic automation preferences.'
    exit 0
}
if (-not $Apply) {
    [pscustomobject]@{Profile=$profileDirectory;File=$target;Change='Append remote.prefs.recommended=false';Purpose='Prevent Firefox Remote Agent from changing unrelated preferences';SignaturePolicy='Unchanged';WritesPerformed=$false} | ConvertTo-Json
    exit 0
}
$receiptPath = Join-Path $profileDirectory ('zen-native-setup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.json')
$updated = $text + "`r`n// Zen Browser Bridge: preserve normal browser preferences in native mode.`r`nuser_pref(`"remote.prefs.recommended`", false);`r`n"
$utf8 = [Text.UTF8Encoding]::new($false)
$bytes = $utf8.GetBytes($updated)
$sha = [Security.Cryptography.SHA256]::Create()
try { $expected = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '') } finally { $sha.Dispose() }
$receipt = [ordered]@{version=1;profile=$profileDirectory;target=$target;originalBase64=[Convert]::ToBase64String($original);originalPreference=$originalPreference;resultHash=$expected}
[IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json), $utf8)
[IO.File]::WriteAllBytes($target, $bytes)
if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $expected) { throw 'Configuration read-back verification failed.' }
Write-Output "Configured only remote.prefs.recommended. Rollback receipt: $receiptPath"
