# Kill any remaining python
Get-Process python -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
$remaining = (Get-Process python -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host "Remaining python processes: $remaining"

# Check whisper model cache
$modelPath = Join-Path $env:USERPROFILE ".cache\whisper\base.pt"
if (Test-Path $modelPath) {
    $size = [math]::Round((Get-Item $modelPath).Length / 1MB, 1)
    Write-Host "Whisper base model cached: $size MB"
} else {
    Write-Host "Whisper base model NOT cached - will need to download"
}

# Check what transcripts we have
Write-Host "`nExisting transcripts:"
$dir = "C:\Users\derek\Projects\atlas\data\training\brunson-ofa"
Get-ChildItem "$dir\*.txt" -ErrorAction SilentlyContinue | ForEach-Object {
    $kb = [math]::Round($_.Length / 1KB, 1)
    Write-Host "  $($_.Name) - $kb KB"
}

# List what's missing
$episodes = @(
    @{ day = 1;  title = "One-Funnel-Away" }
    @{ day = 2;  title = "Offer-Hacking" }
    @{ day = 3;  title = "Creating-Your-Offer" }
    @{ day = 4;  title = "The-ASK-Campaign" }
    @{ day = 5;  title = "Building-Your-Funnel" }
    @{ day = 6;  title = "The-Perfect-Webinar" }
    @{ day = 7;  title = "The-VSL-Page" }
    @{ day = 8;  title = "The-Order-Form" }
    @{ day = 9;  title = "Your-Membership-Site" }
    @{ day = 10; title = "Traffic" }
)

Write-Host "`nMissing transcripts:"
foreach ($ep in $episodes) {
    $txtFile = "$dir\day-$($ep.day)-$($ep.title).txt"
    $audioFile = "$dir\audio\day-$($ep.day).mp3"
    if (-not (Test-Path $txtFile)) {
        $hasAudio = Test-Path $audioFile
        Write-Host "  Day $($ep.day) - $($ep.title) (audio: $hasAudio)"
    }
}
