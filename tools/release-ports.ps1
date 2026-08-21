# Release workbench ports (5173 frontend, 8787 server, 5175 legacy prototype).
# ASCII only: PowerShell 5.1 reads BOM-less files as ANSI and corrupts non-ASCII text.
$ports = @(5173, 8787, 5175)
foreach ($port in $ports) {
    $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
        $processId = $connection.OwningProcess
        if ($processId -and $processId -ne 0) {
            try {
                $process = Get-Process -Id $processId -ErrorAction Stop
                Write-Output ("port {0}: stopping {1} (pid {2})" -f $port, $process.ProcessName, $processId)
                Stop-Process -Id $processId -Force -Confirm:$false
            } catch {
                Write-Output ("port {0}: pid {1} already exited" -f $port, $processId)
            }
        }
    }
    if (-not $connections) { Write-Output ("port {0}: free" -f $port) }
}
