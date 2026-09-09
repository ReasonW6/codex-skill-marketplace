[CmdletBinding()]
param([string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'ReasonW6\ZenBrowser'))
$ErrorActionPreference = 'Stop'
$registryPath = 'HKCU:\Software\Mozilla\NativeMessagingHosts\io.github.reasonw6.zen_browser'
$registered = Test-Path -LiteralPath $registryPath
$manifestPath = if ($registered) { (Get-Item -LiteralPath $registryPath).GetValue('') } else { $null }
$manifestExists = $manifestPath -and (Test-Path -LiteralPath $manifestPath)
$native = if ($manifestExists) { Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } else { $null }
$connectionDir = Join-Path $InstallRoot 'connections'
$connections = @()
if (Test-Path -LiteralPath $connectionDir) {
    $connections = @(Get-ChildItem -LiteralPath $connectionDir -File | Where-Object Name -Match '^[a-f0-9-]{36}\.json$' | ForEach-Object {
        try {
            $entry = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
            if (Get-Process -Id $entry.pid -ErrorAction SilentlyContinue) {
                [pscustomobject]@{ connectionId = $entry.id; browser = $entry.browser; startedAt = $entry.startedAt }
            }
        } catch { Write-Warning "Could not inspect $($_.Name)" }
    })
}
[pscustomobject]@{
    registered = $registered; manifestExists = [bool]$manifestExists
    launcherExists = [bool]($native -and (Test-Path -LiteralPath $native.path))
    allowedExtensions = $native.allowed_extensions; connections = $connections
    node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
} | ConvertTo-Json -Depth 6
