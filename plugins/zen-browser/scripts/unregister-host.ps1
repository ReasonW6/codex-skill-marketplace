[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Receipt)
$ErrorActionPreference = 'Stop'
$record = Get-Content -LiteralPath $Receipt -Raw | ConvertFrom-Json
$expected = 'HKCU:\Software\Mozilla\NativeMessagingHosts\io.github.reasonw6.zen_browser'
if ($record.registryPath -ne $expected -and $record.registryPath -ne ($expected + '_test')) { throw 'Receipt contains an unexpected registry path.' }
$current = (Get-Item -LiteralPath $record.registryPath -ErrorAction Stop).GetValue('')
if ($current -ne $record.manifestPath) { throw 'A later install owns this registration. Use its receipt first.' }
if ($record.previousManifest) { Set-Item -LiteralPath $record.registryPath -Value $record.previousManifest }
else { Remove-Item -LiteralPath $record.registryPath }
Write-Output 'Native host registration rolled back. Runtime files and receipts were retained; no browser profile or extension was changed.'
