param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [Parameter(Mandatory = $true)]
    [string]$ValidationDirectory,

    [string]$AutoCADExe = 'D:\AutoCAD 2024\accoreconsole.exe',
    [string]$BlenderExe = 'D:\Blender 5.0\blender.exe',
    [string]$DxfFile = 't0-multiview-sheet.dxf',
    [string]$GlbFile = 't0-minimal-hall.glb',
    [string]$EvidencePrefix = '',
    [string]$ResultFile = 'external-verification.json',
    [string]$Gate = 'T0-A',
    [string]$QualityLevel = 'L0',
    [int]$MinimumMeshObjects = 1
)

$ErrorActionPreference = 'Stop'
$output = (Resolve-Path -LiteralPath $OutputDirectory).Path
$validation = (Resolve-Path -LiteralPath $ValidationDirectory).Path
$scriptRoot = $PSScriptRoot
$tempBase = [System.IO.Path]::GetTempPath().TrimEnd('\')
$tempRoot = Join-Path $tempBase 'gujian-t0-autocad'
$utf8 = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path -LiteralPath $AutoCADExe)) {
    throw "AutoCAD Core Console not found: $AutoCADExe"
}
if (-not (Test-Path -LiteralPath $BlenderExe)) {
    throw "Blender not found: $BlenderExe"
}

if (Test-Path -LiteralPath $tempRoot) {
    $resolved = (Resolve-Path -LiteralPath $tempRoot).Path
    if (-not $resolved.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolved) -ne 'gujian-t0-autocad') {
        throw "Unsafe temp target: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

New-Item -ItemType Directory -Path $tempRoot | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tempRoot 'profile') | Out-Null
Copy-Item -LiteralPath (Join-Path $output $DxfFile) -Destination (Join-Path $tempRoot 'sheet.dxf')
Copy-Item -LiteralPath (Join-Path $scriptRoot 'autocad-audit.scr') -Destination (Join-Path $tempRoot 'audit.scr')

$stdout = Join-Path $tempRoot 'stdout.txt'
$stderr = Join-Path $tempRoot 'stderr.txt'
$arguments = @(
    '/i', (Join-Path $tempRoot 'sheet.dxf'),
    '/s', (Join-Path $tempRoot 'audit.scr'),
    '/l', 'en-US',
    '/isolate', 'gujian-t0', (Join-Path $tempRoot 'profile')
)

$process = Start-Process -FilePath $AutoCADExe -ArgumentList $arguments -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -WindowStyle Hidden -Wait
$autocadExit = $process.ExitCode

$autocadLog = [System.IO.File]::ReadAllText($stdout, [System.Text.Encoding]::Unicode)
$autocadEvidence = Join-Path $validation ($EvidencePrefix + 'autocad-audit.log')
[System.IO.File]::WriteAllText($autocadEvidence, $autocadLog, $utf8)
$auditPhrase = [string]::Concat([char]0x5171, [char]0x53D1, [char]0x73B0, ' 0 ', [char]0x4E2A, [char]0x9519, [char]0x8BEF)
$fontPhrase = [string]::Concat([char]0x6B63, [char]0x5728, [char]0x7528)
$auditPassed = $autocadLog.Contains($auditPhrase) -or $autocadLog.Contains('Total errors found 0')
$fontSubstitution = $autocadLog.Contains($fontPhrase) -or $autocadLog.Contains('Substituting')
if (-not $auditPassed) {
    throw 'AutoCAD audit did not report zero errors'
}
if ($autocadExit -ne 0) {
    throw "AutoCAD Core Console exited with code $autocadExit"
}
if ($fontSubstitution) {
    throw 'AutoCAD substituted one or more fonts'
}

$preview = Join-Path $validation ($EvidencePrefix + 'blender-preview.png')
$blenderStdout = Join-Path $tempRoot 'blender-stdout.txt'
$blenderStderr = Join-Path $tempRoot 'blender-stderr.txt'
$blenderArguments = @('--factory-startup', '--disable-autoexec', '--background', '--python', (Join-Path $scriptRoot 'blender_verify.py'), '--', (Join-Path $output $GlbFile), $preview)
$blenderProcess = Start-Process -FilePath $BlenderExe -ArgumentList $blenderArguments -RedirectStandardOutput $blenderStdout -RedirectStandardError $blenderStderr -PassThru -WindowStyle Hidden -Wait
$blenderExit = $blenderProcess.ExitCode
$blenderLog = [System.IO.File]::ReadAllText($blenderStdout) + [System.IO.File]::ReadAllText($blenderStderr)
$blenderEvidencePath = Join-Path $validation ($EvidencePrefix + 'blender-verify.log')
[System.IO.File]::WriteAllText($blenderEvidencePath, $blenderLog, $utf8)
if ($blenderExit -ne 0 -or -not (Test-Path -LiteralPath $preview) -or -not $blenderLog.Contains('"status": "passed"')) {
    throw "Blender verification failed with exit code $blenderExit"
}
$blenderJsonLine = ($blenderLog -split '\r?\n' | Where-Object { $_.TrimStart().StartsWith('{"status": "passed"') } | Select-Object -Last 1)
if (-not $blenderJsonLine) {
    throw 'Blender verification JSON was not found'
}
$blenderResult = $blenderJsonLine | ConvertFrom-Json
if ([int]$blenderResult.meshObjects -lt $MinimumMeshObjects) {
    throw "Blender imported fewer meshes than required: $($blenderResult.meshObjects)"
}

$result = [ordered]@{
    schemaVersion = 't0-external-verification-1'
    status = 'passed'
    gate = $Gate
    qualityLevel = $QualityLevel
    autocad = [ordered]@{
        executable = $AutoCADExe
        version = (Get-Item -LiteralPath $AutoCADExe).VersionInfo.ProductVersion
        exitCode = $autocadExit
        auditZeroErrors = $true
        fontSubstitution = $false
        logSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $autocadEvidence).Hash.ToLowerInvariant()
    }
    blender = [ordered]@{
        executable = $BlenderExe
        version = (Get-Item -LiteralPath $BlenderExe).VersionInfo.ProductVersion
        meshObjects = [int]$blenderResult.meshObjects
        previewSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $preview).Hash.ToLowerInvariant()
        logSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $blenderEvidencePath).Hash.ToLowerInvariant()
    }
}
[System.IO.File]::WriteAllText((Join-Path $validation $ResultFile), ($result | ConvertTo-Json -Depth 6), $utf8)

$resolvedTemp = (Resolve-Path -LiteralPath $tempRoot).Path
if ($resolvedTemp.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedTemp) -eq 'gujian-t0-autocad') {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
}

$result | ConvertTo-Json -Depth 6
