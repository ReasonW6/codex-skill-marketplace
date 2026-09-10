[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'ReasonW6\ZenBrowser'),
    [string]$NodePath = '',
    [string]$HostName = 'io.github.reasonw6.zen_browser'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
if ($env:OS -ne 'Windows_NT') { throw 'This installer supports Windows only.' }
if ($HostName -notmatch '^io\.github\.reasonw6\.zen_browser(?:_test)?$') { throw 'Unsupported native host name.' }
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installPath = [IO.Path]::GetFullPath($InstallRoot)
if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$nodeExecutable = (Resolve-Path -LiteralPath $NodePath).Path
$nodeMajor = [int]((& $nodeExecutable --version) -replace '^v(\d+).*$','$1')
if ($nodeMajor -lt 22) { throw 'Node.js 22 or newer is required.' }
# The native launcher passes paths directly to CreateProcess, without shell expansion.
foreach ($item in @($installPath, $nodeExecutable)) {
    if ($item -match '["\r\n]') { throw 'Paths containing quotes or newlines cannot be used by the native launcher.' }
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.Name -match 'CodexSandbox') { throw 'Run this installer as your normal Windows user, not a dedicated sandbox account.' }
if (Test-Path -LiteralPath $installPath) {
    $owner = (Get-Acl -LiteralPath $installPath).Owner
    if ($owner -ne $identity.Name -and $owner -ne $identity.User.Value) { throw "Install directory belongs to another identity: $owner" }
    $existingItems = @(Get-ChildItem -LiteralPath $installPath -Force)
    if ($existingItems.Count -gt 0) {
        $previousReceipt = $existingItems | Where-Object { -not $_.PSIsContainer -and $_.Name -match '^install-[0-9-]+\.json$' } | Sort-Object Name -Descending | Select-Object -First 1
        if (-not $previousReceipt) { throw 'Refusing to change a non-empty directory that has no Zen Browser install receipt.' }
        $previousInstall = Get-Content -LiteralPath $previousReceipt.FullName -Raw | ConvertFrom-Json
        if ($previousInstall.installRoot -ne $installPath -or $previousInstall.registryPath -ne "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName") { throw 'Existing install receipt does not match this directory and native host.' }
    }
} else { New-Item -ItemType Directory -Path $installPath | Out-Null }
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($identity.User)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sidValue in @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $sid = New-Object Security.Principal.SecurityIdentifier($sidValue)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $installPath -AclObject $acl
$version = (Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json).version
$buildHash = (Get-FileHash -LiteralPath (Join-Path $sourceRoot 'server\native-host.mjs') -Algorithm SHA256).Hash.Substring(0, 12).ToLowerInvariant()
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$runtimePath = Join-Path $installPath "runtime\$version-$buildHash-$stamp"
New-Item -ItemType Directory -Path $runtimePath | Out-Null
foreach ($name in @('native-host.mjs', 'wire.mjs', 'paths.mjs', 'bidi.mjs', 'native-driver.mjs')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot "server\$name") -Destination (Join-Path $runtimePath $name)
}
$utf8 = New-Object Text.UTF8Encoding($false)
$launcher = Join-Path $runtimePath 'zen-native-host.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework C# compiler is required to build the native launcher.' }
$compilerOutput = & $compiler /nologo /target:exe /optimize+ "/out:$launcher" (Join-Path $PSScriptRoot 'NativeLauncher.cs') 2>&1
if ($LASTEXITCODE -ne 0) { throw "Native launcher compilation failed: $compilerOutput" }
$probeExecutable = Join-Path $runtimePath 'zen-input-probe.exe'
$probeOutput = & $compiler /nologo /target:exe /optimize+ "/out:$probeExecutable" (Join-Path $PSScriptRoot 'PhysicalInputProbe.cs') 2>&1
if ($LASTEXITCODE -ne 0) { throw "Input provenance helper compilation failed: $probeOutput" }
$launcherConfig = @($nodeExecutable, (Join-Path $runtimePath 'native-host.mjs'), $installPath) -join "`n"
[IO.File]::WriteAllText((Join-Path $runtimePath 'launcher-paths.txt'), $launcherConfig, $utf8)
$manifestPath = Join-Path $runtimePath "$HostName.json"
$manifest = [ordered]@{
    name = $HostName; description = 'Local Zen Browser bridge for Codex'; path = $launcher; type = 'stdio'
    allowed_extensions = @('zen-browser@reasonw6.github.io')
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5), $utf8)
$registryPath = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"
$previous = if (Test-Path -LiteralPath $registryPath) { (Get-Item -LiteralPath $registryPath).GetValue('') } else { $null }
$receipt = [ordered]@{
    version = $version; installedAt = (Get-Date).ToUniversalTime().ToString('o'); identity = $identity.Name
    registryPath = $registryPath; previousManifest = $previous; manifestPath = $manifestPath
    nodePath = $nodeExecutable; runtimePath = $runtimePath; installRoot = $installPath
}
$receiptPath = Join-Path $installPath "install-$stamp.json"
[IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 5), $utf8)
New-Item -Path $registryPath -Force | Out-Null
Set-Item -LiteralPath $registryPath -Value $manifestPath
if ((Get-Item -LiteralPath $registryPath).GetValue('') -ne $manifestPath) { throw 'Native host registry verification failed.' }
Write-Output "Installed native host for $($identity.Name)."
Write-Output "Manifest: $manifestPath"
Write-Output "Rollback receipt: $receiptPath"
Write-Output 'Use scripts/start-zen.ps1 to load the unsigned extension automatically at startup, or load extension/manifest.json manually in about:debugging.'
