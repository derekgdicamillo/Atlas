## OFA Expert Challenge Transcription Script
## Downloads audio from CoursesCast podcast feed and transcribes with Whisper

$outDir = "C:\Users\derek\Projects\atlas\data\training\brunson-ofa"
$audioDir = "$outDir\audio"

New-Item -ItemType Directory -Force $audioDir | Out-Null

$episodes = @(
    @{ day = 1;  title = "One-Funnel-Away";      url = "https://coursecast.herokuapp.com/download/32cc0cadefd3b21f0b787affba267f8b/d8c6abd04af3e9f3980b14cefbb3c3e1" }
    @{ day = 2;  title = "Offer-Hacking";         url = "https://coursecast.herokuapp.com/download/32cc0cadefd3b21f0b787affba267f8b/2892e5c9700a68dfc6e6f3dba1150bdd" }
    @{ day = 3;  title = "Creating-Your-Offer";   url = "https://coursecast.herokuapp.com/download/32cc0cadefd3b21f0b787affba267f8b/f397e4a764df8982598c7759d0b0911d" }
    @{ day = 4;  title = "The-ASK-Campaign";      url = "https://coursecast.herokuapp.com/download/32cc0cadefd3b21f0b787affba267f8b/aa758be71dc0a9b51560afb566f24c08" }
    @{ day = 5;  title = "Building-Your-Funnel";  url = "https://coursecast.herokuapp.com/download/32cc0cadefd3b21f0b787affba267f8b/3cf159073dcfe4525a00906caf860f33" }
    @{ day = 6;  title = "The-Perfect-Webinar";   url = "https://coursecast.herokuapp.com/download/32cc0cadefd3b21f0b787affba267f8b/622c9c63e502828f33f171b19ff78f40" }
    @{ day = 7;  title = "The-VSL-Page";          url = "https://coursecast.herokuapp.com/download/32cc0cadefd3b21f0b787affba267f8b/1f61c75007be402bcd46796e64f7f932" }
    @{ day = 8;  title = "The-Order-Form";        url = "https://coursecast.herokuapp.com/download/32cc0cadefd3b21f0b787affba267f8b/65e34fbcbfc072d5eaedc5d78ca062bd" }
    @{ day = 9;  title = "Your-Membership-Site";  url = "https://coursecast.herokuapp.com/download/32cc0cadefd3b21f0b787affba267f8b/9576248275e401e4b9733af5f5ed69b0" }
    @{ day = 10; title = "Traffic";               url = "https://coursecast.herokuapp.com/download/32cc0cadefd3b21f0b787affba267f8b/13256b0ae72590a75972b7c8b018e896" }
)

foreach ($ep in $episodes) {
    $day = $ep.day
    $title = $ep.title
    $audioFile = "$audioDir\day-$day.mp3"
    $txtFile = "$outDir\day-$day-$title.txt"

    # Skip if transcript already exists
    if (Test-Path $txtFile) {
        Write-Host "[$day/10] SKIP: $title (transcript exists)"
        continue
    }

    # Step 1: Download audio
    if (-not (Test-Path $audioFile)) {
        Write-Host "[$day/10] Downloading: $title..."
        try {
            Invoke-WebRequest -Uri $ep.url -OutFile $audioFile -UseBasicParsing
            $sizeMB = [math]::Round((Get-Item $audioFile).Length / 1MB, 1)
            Write-Host "[$day/10] Downloaded: $sizeMB MB"
        } catch {
            Write-Host "[$day/10] ERROR downloading: $_"
            continue
        }
    } else {
        Write-Host "[$day/10] Audio cached: $title"
    }

    # Step 2: Transcribe with Whisper (base model for speed)
    Write-Host "[$day/10] Transcribing: $title..."
    $startTime = Get-Date
    python -m whisper $audioFile --model base --language en --output_format txt --output_dir $outDir 2>&1 | Out-Null
    $elapsed = [math]::Round(((Get-Date) - $startTime).TotalMinutes, 1)

    # Rename whisper output (whisper names it after the input file)
    $whisperFile = "$outDir\day-$day.txt"
    if (Test-Path $whisperFile) {
        Move-Item $whisperFile $txtFile -Force
        Write-Host "[$day/10] DONE: $title ($elapsed min)"
    } else {
        Write-Host "[$day/10] ERROR: Whisper output not found"
    }
}

# Cleanup
Remove-Item "$outDir\..\test_audio.mp3" -ErrorAction SilentlyContinue

Write-Host "`n=== All transcriptions complete ==="
Write-Host "Output: $outDir"
Get-ChildItem "$outDir\*.txt" | ForEach-Object { Write-Host "  $($_.Name) ($([math]::Round($_.Length/1KB,1)) KB)" }
