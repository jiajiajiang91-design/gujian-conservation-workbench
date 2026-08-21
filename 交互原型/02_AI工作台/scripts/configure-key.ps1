param(
  [string]$EnvPath = (Join-Path $PSScriptRoot "..\.env")
)

$ErrorActionPreference = "Stop"
$clipboard = Get-Clipboard -Raw
$key = if ($null -eq $clipboard) { "" } else { [string]$clipboard }
$key = $key.Trim()

if ([string]::IsNullOrWhiteSpace($key) -or -not $key.StartsWith("sk-")) {
  throw "No recognizable API key found in clipboard"
}
if ($key.Contains("`r") -or $key.Contains("`n") -or $key.Contains("=")) {
  throw "Invalid API key format"
}

$fullPath = [IO.Path]::GetFullPath($EnvPath)
if (-not [IO.File]::Exists($fullPath)) {
  throw ".env file not found"
}

$lines = [IO.File]::ReadAllLines($fullPath)
$updated = $false
for ($i = 0; $i -lt $lines.Length; $i++) {
  if ($lines[$i].StartsWith("MOONSHOT_API_KEY=")) {
    $lines[$i] = "MOONSHOT_API_KEY=" + $key
    $updated = $true
    break
  }
}
if (-not $updated) {
  $lines = @("MOONSHOT_API_KEY=" + $key) + $lines
}

[IO.File]::WriteAllLines($fullPath, $lines, [Text.UTF8Encoding]::new($false))
try { Set-Clipboard -Value " " } catch { }
$clipboard = $null
$key = $null

Write-Output "KEY_CONFIGURED=true"
Write-Output "CLIPBOARD_CLEARED=true"
