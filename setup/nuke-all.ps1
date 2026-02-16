# Find powershell processes running our transcription scripts
$myPid = $PID
Write-Host "My PID: $myPid (will not kill self)"

# Kill ffmpeg first (children), then python, then look for parent powershells
$rounds = 3
for ($i = 1; $i -le $rounds; $i++) {
    Write-Host "`n--- Round $i ---"

    # Kill ffmpeg
    Get-Process ffmpeg -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "Kill ffmpeg $($_.Id)"
        $_.Kill()
    }

    # Kill python
    Get-Process python -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "Kill python $($_.Id)"
        $_.Kill()
    }

    Start-Sleep -Seconds 2
}

# Final check
Write-Host "`n=== Final check ==="
$py = @(Get-Process python -ErrorAction SilentlyContinue)
$ff = @(Get-Process ffmpeg -ErrorAction SilentlyContinue)
Write-Host "Python: $($py.Count), FFmpeg: $($ff.Count)"

if ($py.Count -eq 0 -and $ff.Count -eq 0) {
    Write-Host "ALL CLEAR - ready for clean transcription"
} else {
    Write-Host "WARNING: Some processes survived"
    $py | ForEach-Object { Write-Host "  python PID $($_.Id)" }
    $ff | ForEach-Object { Write-Host "  ffmpeg PID $($_.Id)" }
}
