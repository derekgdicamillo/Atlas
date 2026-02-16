$procs = Get-Process python -ErrorAction SilentlyContinue
foreach ($p in $procs) {
    Write-Host "Killing PID $($p.Id)..."
    try {
        Stop-Process -Id $p.Id -Force -ErrorAction Stop
        Write-Host "  Killed"
    } catch {
        Write-Host "  Failed: $($_.Exception.Message)"
        # Try taskkill as fallback
        & taskkill /F /PID $p.Id 2>&1
    }
}
Start-Sleep -Seconds 3
$remaining = @(Get-Process python -ErrorAction SilentlyContinue)
Write-Host "Remaining: $($remaining.Count) python processes"
if ($remaining.Count -gt 0) {
    foreach ($p in $remaining) {
        Write-Host "  Still alive: PID $($p.Id)"
    }
}
