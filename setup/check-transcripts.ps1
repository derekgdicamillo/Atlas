$dir = "C:\Users\derek\Projects\atlas\data\training\brunson-ofa"
Write-Host "=== All txt files ==="
Get-ChildItem "$dir\*.txt" | Sort-Object Name | ForEach-Object {
    $kb = [math]::Round($_.Length / 1KB, 1)
    Write-Host "  $($_.Name) - $kb KB - $($_.LastWriteTime)"
}

# Also check for whisper's default output names (day-N.txt before rename)
Write-Host "`n=== Whisper default outputs (not yet renamed) ==="
for ($i = 1; $i -le 10; $i++) {
    $f = "$dir\day-$i.txt"
    if (Test-Path $f) {
        $kb = [math]::Round((Get-Item $f).Length / 1KB, 1)
        Write-Host "  day-$i.txt - $kb KB"
    }
}

Write-Host "`n=== Currently running ==="
Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" | ForEach-Object {
    $cmd = $_.CommandLine
    if ($cmd -match "day-(\d+)\.mp3") {
        Write-Host "  Transcribing Day $($Matches[1]) (PID $($_.ProcessId))"
    }
}
