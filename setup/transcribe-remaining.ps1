## Transcribe remaining OFA days (1, 3, 4, 5, 6, 7, 8)
## Runs ONE AT A TIME to avoid CPU contention

$outDir = "C:\Users\derek\Projects\atlas\data\training\brunson-ofa"
$audioDir = "$outDir\audio"

# Ordered by audio length (shortest first for quick wins)
$remaining = @(
    @{ day = 4;  title = "The-ASK-Campaign" }       # 13 min
    @{ day = 5;  title = "Building-Your-Funnel" }    # 30 min
    @{ day = 8;  title = "The-Order-Form" }          # 20 min
    @{ day = 7;  title = "The-VSL-Page" }            # 25 min
    @{ day = 6;  title = "The-Perfect-Webinar" }     # 47 min
    @{ day = 3;  title = "Creating-Your-Offer" }     # 65 min
    @{ day = 1;  title = "One-Funnel-Away" }         # 74 min
)

$total = $remaining.Count
$done = 0

foreach ($ep in $remaining) {
    $day = $ep.day
    $title = $ep.title
    $audioFile = "$audioDir\day-$day.mp3"
    $txtFile = "$outDir\day-$day-$title.txt"

    # Skip if already done
    if (Test-Path $txtFile) {
        Write-Host "[$day/10] SKIP: $title (already exists)"
        $done++
        continue
    }

    # Verify audio exists
    if (-not (Test-Path $audioFile)) {
        Write-Host "[$day/10] ERROR: Audio file missing!"
        continue
    }

    $sizeMB = [math]::Round((Get-Item $audioFile).Length / 1MB, 1)
    Write-Host "[$day/10] Transcribing: $title ($sizeMB MB)..."
    $startTime = Get-Date

    # Run whisper
    python -m whisper $audioFile --model base --language en --output_format txt --output_dir $outDir 2>&1 | Out-Null

    $elapsed = [math]::Round(((Get-Date) - $startTime).TotalMinutes, 1)

    # Rename whisper output
    $whisperFile = "$outDir\day-$day.txt"
    if (Test-Path $whisperFile) {
        Move-Item $whisperFile $txtFile -Force
        $kb = [math]::Round((Get-Item $txtFile).Length / 1KB, 1)
        $done++
        Write-Host "[$day/10] DONE: $title ($elapsed min, $kb KB) [$done/$total remaining complete]"
    } else {
        Write-Host "[$day/10] ERROR: Whisper output not found after $elapsed min"
    }
}

Write-Host "`n=== Remaining transcriptions complete ==="
Write-Host "All transcripts:"
Get-ChildItem "$outDir\*.txt" | Sort-Object Name | ForEach-Object {
    $kb = [math]::Round($_.Length / 1KB, 1)
    Write-Host "  $($_.Name) - $kb KB"
}
