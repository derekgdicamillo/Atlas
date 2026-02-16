# Kill ALL python and ffmpeg processes aggressively
$targets = @("python", "python3", "ffmpeg")
foreach ($name in $targets) {
    $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        Write-Host "Killing $name PID $($p.Id)..."
        $p.Kill()
    }
}

# Wait and recheck
Start-Sleep -Seconds 5

$still = @()
foreach ($name in $targets) {
    $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        $still += "$name PID $($p.Id)"
    }
}

if ($still.Count -eq 0) {
    Write-Host "`nAll clear. No python/ffmpeg processes running."
} else {
    Write-Host "`nStill running:"
    $still | ForEach-Object { Write-Host "  $_" }
}
