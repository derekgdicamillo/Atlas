# Kill the Day 10 process (longer file, let Day 9 finish first since it's shorter)
# Day 10 parent PowerShell is PID 27640, python child is 37956
# Day 9 parent PowerShell is PID 5076, python child is 18720

# Kill Day 10's python child and its parent PS
Write-Host "Killing Day 10 transcription (python PID 37956)..."
Stop-Process -Id 37956 -Force -ErrorAction SilentlyContinue

Write-Host "Killing Day 10 parent script (PS PID 27640)..."
Stop-Process -Id 27640 -Force -ErrorAction SilentlyContinue

# Also kill any ffmpeg children
Get-Process ffmpeg -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "Killing ffmpeg PID $($_.Id)"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2

# Verify only Day 9 remains
Write-Host "`n=== Still running ==="
Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" | ForEach-Object {
    $cmd = $_.CommandLine
    if ($cmd -match "day-(\d+)\.mp3") {
        Write-Host "  Transcribing Day $($Matches[1]) (PID $($_.ProcessId))"
    } else {
        Write-Host "  python PID $($_.ProcessId)"
    }
}

$ps = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -like "*transcribe-ofa*" }
Write-Host "Transcription PS scripts: $($ps.Count)"
