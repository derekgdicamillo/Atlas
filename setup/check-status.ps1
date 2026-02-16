Write-Host "=== AUDIO FILES ==="
Get-ChildItem "C:\Users\derek\Projects\atlas\data\training\brunson-ofa\audio\*.mp3" | ForEach-Object {
    $mb = [math]::Round($_.Length / 1MB, 1)
    Write-Host "  $($_.Name) - $mb MB"
}

Write-Host "`n=== TRANSCRIPTS ==="
$txts = Get-ChildItem "C:\Users\derek\Projects\atlas\data\training\brunson-ofa\*.txt" -ErrorAction SilentlyContinue
if ($txts) {
    $txts | ForEach-Object {
        $kb = [math]::Round($_.Length / 1KB, 1)
        Write-Host "  $($_.Name) - $kb KB (modified: $($_.LastWriteTime))"
    }
} else {
    Write-Host "  (none found)"
}

Write-Host "`n=== PYTHON PROCESSES ==="
Get-Process python -ErrorAction SilentlyContinue | ForEach-Object {
    $runtime = [math]::Round(((Get-Date) - $_.StartTime).TotalMinutes, 1)
    Write-Host "  PID $($_.Id) - running $runtime min - CPU $([math]::Round($_.CPU, 0))s"
}

Write-Host "`n=== LOG TAIL ==="
if (Test-Path "C:\Users\derek\Projects\atlas\data\training\brunson-ofa\transcribe.log") {
    Get-Content "C:\Users\derek\Projects\atlas\data\training\brunson-ofa\transcribe.log" -Tail 30
} else {
    Write-Host "  (no log file)"
}
