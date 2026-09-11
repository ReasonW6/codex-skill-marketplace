[CmdletBinding()]
param([string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $sourceRoot 'bin' }
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The maintainer build needs the Windows .NET Framework compiler.' }
$programs = @(
    @{ Source = 'NativeLauncher.cs'; Name = 'zen-native-host.exe'; References = @() },
    @{ Source = 'PhysicalInputProbe.cs'; Name = 'zen-input-probe.exe'; References = @() },
    @{ Source = 'ZenPlatform.cs'; Name = 'zen-platform.exe'; References = @('/reference:System.Management.dll', '/reference:System.Web.Extensions.dll', '/reference:Microsoft.CSharp.dll', ('/reference:' + (Join-Path (Split-Path $compiler) 'WPF\UIAutomationClient.dll')), ('/reference:' + (Join-Path (Split-Path $compiler) 'WPF\UIAutomationTypes.dll'))) }
)
$manifest = @()
$previous = @()
$manifestPath = Join-Path $outputPath 'manifest.json'
if (Test-Path -LiteralPath $manifestPath) { $previous = @(Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json) }
foreach ($program in $programs) {
    $source = Join-Path $PSScriptRoot $program.Source
    $target = Join-Path $outputPath $program.Name
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    $existing = $previous | Where-Object { $_.file -eq $program.Name } | Select-Object -First 1
    $current = $existing -and $existing.sourceSha256 -eq $sourceHash -and (Test-Path -LiteralPath $target) -and (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -eq $existing.sha256
    if (-not $current) {
        & $compiler /nologo /target:exe /optimize+ "/out:$target" $program.References $source
        if ($LASTEXITCODE -ne 0) { throw "Compilation failed: $($program.Source)" }
    }
    $manifest += [ordered]@{ file = $program.Name; source = ('scripts/' + $program.Source); sourceSha256 = $sourceHash; sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() }
}
[IO.File]::WriteAllText((Join-Path $outputPath 'manifest.json'), ($manifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
Write-Output "Built $($programs.Count) bundled Windows helpers. End users do not run this script."
