# Find what's spawning python processes
$myPid = $PID

# Check all powershell processes and their command lines
Write-Host "=== PowerShell processes ==="
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | ForEach-Object {
    if ($_.ProcessId -ne $myPid) {
        Write-Host "PID $($_.ProcessId) - Parent: $($_.ParentProcessId)"
        $cmd = $_.CommandLine
        if ($cmd.Length -gt 200) { $cmd = $cmd.Substring(0, 200) + "..." }
        Write-Host "  CMD: $cmd"
    }
}

Write-Host "`n=== Python processes ==="
Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" | ForEach-Object {
    Write-Host "PID $($_.ProcessId) - Parent: $($_.ParentProcessId)"
    $cmd = $_.CommandLine
    if ($cmd.Length -gt 200) { $cmd = $cmd.Substring(0, 200) + "..." }
    Write-Host "  CMD: $cmd"
}
