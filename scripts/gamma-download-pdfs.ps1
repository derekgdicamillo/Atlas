# gamma-download-pdfs.ps1
# Re-download PDFs from previously completed Gamma generations
# Uses generationIds from the results log to fetch exportUrl and download

$resultsLog = "C:\Users\derek\Projects\atlas\scripts\gamma-handout-results.jsonl"
$outputDir = "C:\Users\derek\OneDrive - PV MEDISPA LLC\03_VitalityUnchained\Course_PDFs\GLP1-CEU\Module-11 - Patient Education Resource Pack"

$apiKey = [System.Environment]::GetEnvironmentVariable('GAMMA_API_KEY', 'User')
if (-not $apiKey) {
    Write-Error "GAMMA_API_KEY not found in user environment variables"
    exit 1
}

# Ensure output dir exists
if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

# Read all entries, deduplicate by title (keep latest per title)
$rawLines = Get-Content $resultsLog -Encoding UTF8 | Where-Object { $_.Trim() }
$entries = @()
foreach ($line in $rawLines) {
    $clean = $line -replace '^\xEF\xBB\xBF', ''
    try {
        $parsed = $clean | ConvertFrom-Json
        $entries += $parsed
    } catch {
        Write-Host "Skipping unparseable line: $clean" -ForegroundColor Red
    }
}

# Group by title, keep the last entry for each (most recent)
$uniqueByTitle = @{}
foreach ($entry in $entries) {
    $uniqueByTitle[$entry.title] = $entry
}

$handouts = $uniqueByTitle.Values | Sort-Object { $_.timestamp }

Write-Host "=== Gamma PDF Download ===" -ForegroundColor Cyan
Write-Host "Found $($handouts.Count) unique handouts to download"
Write-Host "Output: $outputDir"
Write-Host ""

$downloaded = 0
$noExport = 0
$errors = 0

foreach ($handout in $handouts) {
    $title = $handout.title
    $genId = $handout.generationId
    $gammaUrl = $handout.gammaUrl

    Write-Host "[$($downloaded + $noExport + $errors + 1)/$($handouts.Count)] $title" -ForegroundColor Yellow

    # Poll the generation endpoint for exportUrl
    $exportUrl = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $result = Invoke-RestMethod -Uri "https://public-api.gamma.app/v1.0/generations/$genId" `
                -Headers @{ "X-API-KEY" = $apiKey }
            $exportUrl = $result.exportUrl
            $status = $result.status

            if ($exportUrl) { break }
            if ($attempt -lt 3) {
                Write-Host "  Attempt $attempt/3: exportUrl empty, waiting 5s..." -ForegroundColor Gray
                Start-Sleep -Seconds 5
            }
        } catch {
            Write-Host "  API ERROR: $($_.Exception.Message)" -ForegroundColor Red
            if ($attempt -lt 3) { Start-Sleep -Seconds 3 }
        }
    }

    if ($exportUrl) {
        Write-Host "  Export URL found" -ForegroundColor Green
        $outputFile = Join-Path $outputDir $title

        try {
            Invoke-WebRequest -Uri $exportUrl -OutFile $outputFile
            $fileSize = [math]::Round((Get-Item $outputFile).Length / 1024)
            Write-Host "  Downloaded: $($fileSize)KB -> $title" -ForegroundColor Green
            $downloaded++
        } catch {
            Write-Host "  DOWNLOAD ERROR: $($_.Exception.Message)" -ForegroundColor Red
            $errors++
        }
    } else {
        Write-Host "  No export URL after 3 attempts. Status: $status. Gamma: $gammaUrl" -ForegroundColor Yellow
        $noExport++
    }

    Start-Sleep -Seconds 1
}

Write-Host ""
Write-Host "=== SUMMARY ===" -ForegroundColor Cyan
Write-Host "Downloaded: $downloaded / $($handouts.Count)" -ForegroundColor Green
if ($noExport -gt 0) { Write-Host "No export URL: $noExport" -ForegroundColor Yellow }
if ($errors -gt 0) { Write-Host "Errors: $errors" -ForegroundColor Red }

# List output directory contents
Write-Host ""
Write-Host "Files in output directory:" -ForegroundColor Cyan
Get-ChildItem $outputDir -Filter "*.pdf" | ForEach-Object {
    $sizeKB = [math]::Round($_.Length / 1024)
    Write-Host "  $($_.Name) ($($sizeKB)KB)"
}
