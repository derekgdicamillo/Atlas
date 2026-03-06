# gamma-patient-handouts.ps1
# Generate 12 patient handout PDFs via Gamma API (v2 - fixed exportUrl handling)
# Input: markdown files from MOD11_Patient_Handouts
# Output: PDFs to Module-11 - Patient Education Resource Pack

param(
    [int]$StartFrom = 1,
    [switch]$DryRun
)

$inputDir = "C:\Users\derek\OneDrive - PV MEDISPA LLC\03_VitalityUnchained\Course_PDFs\MOD11_Patient_Handouts"
$outputDir = "C:\Users\derek\OneDrive - PV MEDISPA LLC\03_VitalityUnchained\Course_PDFs\GLP1-CEU\Module-11 - Patient Education Resource Pack"
$resultsLog = "C:\Users\derek\Projects\atlas\scripts\gamma-handout-results.jsonl"

$apiKey = [System.Environment]::GetEnvironmentVariable('GAMMA_API_KEY', 'User')
if (-not $apiKey) {
    Write-Error "GAMMA_API_KEY not found in user environment variables. Set it with: [System.Environment]::SetEnvironmentVariable('GAMMA_API_KEY', 'your-key', 'User')"
    exit 1
}

# Ensure output dir exists
if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    Write-Host "Created output directory: $outputDir"
}

# Define the 12 handouts with correct PE-## naming
$handouts = @(
    @{ File = "Patient Handout - Eating for Success on GLP-1 Therapy.md"; PdfName = "PE-01 Eating for Success on GLP-1 Therapy.pdf" },
    @{ File = "Patient Handout - How to Give Your Weekly Injection.md"; PdfName = "PE-02 How to Give Your Weekly Injection.pdf" },
    @{ File = "Patient Handout - Managing Side Effects.md"; PdfName = "PE-03 Managing Side Effects.pdf" },
    @{ File = "Patient Handout - What to Expect on Your Weight Loss Journey.md"; PdfName = "PE-04 What to Expect on Your Weight Loss Journey.pdf" },
    @{ File = "Patient Handout - Lab Monitoring Guide.md"; PdfName = "PE-05 Lab Monitoring Guide.pdf" },
    @{ File = "Patient Handout - Insurance and Cost Navigation Guide.md"; PdfName = "PE-06 Insurance and Cost Navigation Guide.pdf" },
    @{ File = "Patient Handout - Long-Term Maintenance and What Happens After.md"; PdfName = "PE-07 Long-Term Maintenance and What Happens After.pdf" },
    @{ File = "Patient Handout - Missed Dose Quick Reference Card.md"; PdfName = "PE-08 Missed Dose Quick Reference Card.pdf" },
    @{ File = "Patient Handout - Pre-Treatment Checklist.md"; PdfName = "PE-09 Pre-Treatment Checklist.pdf" },
    @{ File = "Patient Handout - Red Flags and When to Call.md"; PdfName = "PE-10 Red Flags and When to Call.pdf" },
    @{ File = "Patient Handout - Semaglutide vs Tirzepatide Comparison.md"; PdfName = "PE-11 Semaglutide vs Tirzepatide Comparison.pdf" },
    @{ File = "Patient Handout - Special Populations Quick Guide.md"; PdfName = "PE-12 Special Populations Quick Guide.pdf" }
)

$headers = @{
    "X-API-KEY" = $apiKey
    "Content-Type" = "application/json"
}

$total = $handouts.Count
$succeeded = 0
$failed = 0
$noPdf = 0
$results = @()

Write-Host "=== Gamma Patient Handout PDF Generator (v2) ===" -ForegroundColor Cyan
Write-Host "Input:  $inputDir"
Write-Host "Output: $outputDir"
Write-Host "Handouts: $total"
Write-Host "Starting from: #$StartFrom"
if ($DryRun) { Write-Host "MODE: DRY RUN" -ForegroundColor Yellow }
Write-Host ""

for ($i = ($StartFrom - 1); $i -lt $total; $i++) {
    $handout = $handouts[$i]
    $num = $i + 1
    $inputFile = Join-Path $inputDir $handout.File
    $outputFile = Join-Path $outputDir $handout.PdfName

    Write-Host "[$num/$total] $($handout.File)" -ForegroundColor Yellow
    Write-Host "  -> $($handout.PdfName)"

    if (-not (Test-Path $inputFile)) {
        Write-Host "  SKIP: Input file not found" -ForegroundColor Red
        $failed++
        $results += @{ num = $num; title = $handout.PdfName; status = "skipped"; reason = "file not found" }
        continue
    }

    # Read and clean input
    $inputText = [System.IO.File]::ReadAllText($inputFile, [System.Text.Encoding]::UTF8)
    if ($inputText.Length -gt 0 -and $inputText[0] -eq [char]0xFEFF) {
        $inputText = $inputText.Substring(1)
    }
    $inputText = $inputText -replace "`0", ""

    # Strip YAML frontmatter (--- block at start)
    if ($inputText -match "(?s)^---\r?\n.*?\r?\n---\r?\n(.*)$") {
        $inputText = $Matches[1].TrimStart()
    }

    if ($inputText.Length -gt 50000) { $inputText = $inputText.Substring(0, 50000) }
    Write-Host "  Input: $($inputText.Length) chars"

    if ($DryRun) {
        Write-Host "  DRY RUN: would submit to Gamma" -ForegroundColor Gray
        continue
    }

    # Build request body - updated settings per task spec
    $body = @{
        inputText = $inputText
        textMode = "preserve"
        format = "document"
        exportAs = "pdf"
        additionalInstructions = "This is a patient education handout for a medical weight loss clinic. Format for print on letter-size paper. Clean, professional layout. No page breaks in the middle of content sections. Each section should flow naturally. Include the copyright footer at the bottom of every page. Do NOT add filler content or images. Preserve the original structure exactly."
        textOptions = @{
            amount = "detailed"
            tone = "Warm, clear, encouraging, patient-friendly. Written at a 6th grade reading level for adult patients."
            audience = "Adult patients taking GLP-1 weight loss medication (semaglutide or tirzepatide)"
            language = "en"
        }
        imageOptions = @{
            source = "noImages"
        }
        cardOptions = @{
            dimensions = "letter"
        }
    } | ConvertTo-Json -Depth 5

    # Submit generation
    try {
        $response = Invoke-RestMethod -Uri "https://public-api.gamma.app/v1.0/generations" `
            -Method POST -Headers $headers `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
            -ContentType "application/json; charset=utf-8"
        $generationId = $response.generationId
        Write-Host "  Submitted: $generationId"
    } catch {
        Write-Host "  SUBMIT ERROR: $($_.Exception.Message)" -ForegroundColor Red
        $errDetail = $_.ErrorDetails.Message
        if ($errDetail) { Write-Host "  Detail: $errDetail" -ForegroundColor Red }
        $failed++
        $results += @{ num = $num; title = $handout.PdfName; status = "submit_error"; reason = $_.Exception.Message }
        continue
    }

    # Poll for completion (up to 7.5 minutes)
    $status = "pending"
    $attempts = 0
    $maxAttempts = 90
    $result = $null

    while ($status -eq "pending" -and $attempts -lt $maxAttempts) {
        Start-Sleep -Seconds 5
        $attempts++
        try {
            $result = Invoke-RestMethod -Uri "https://public-api.gamma.app/v1.0/generations/$generationId" `
                -Headers @{ "X-API-KEY" = $apiKey }
            $status = $result.status
            if ($attempts % 6 -eq 0) { Write-Host "  Waiting... ($($attempts * 5)s)" -ForegroundColor Gray }
        } catch {
            Write-Host "  POLL ERROR: $($_.Exception.Message)" -ForegroundColor Red
        }
    }

    if ($status -eq "completed") {
        $gammaUrl = $result.gammaUrl
        $exportUrl = $result.exportUrl
        $creditsDeducted = $result.credits.deducted
        $creditsRemaining = $result.credits.remaining

        Write-Host "  Gamma URL: $gammaUrl" -ForegroundColor Green
        Write-Host "  Credits: -$creditsDeducted (remaining: $creditsRemaining)"

        # If exportUrl not populated yet, retry twice with 5s gaps
        if (-not $exportUrl) {
            Write-Host "  exportUrl empty, waiting for PDF export..." -ForegroundColor Gray
            for ($retry = 1; $retry -le 2; $retry++) {
                Start-Sleep -Seconds 5
                try {
                    $result = Invoke-RestMethod -Uri "https://public-api.gamma.app/v1.0/generations/$generationId" `
                        -Headers @{ "X-API-KEY" = $apiKey }
                    $exportUrl = $result.exportUrl
                    if ($exportUrl) {
                        Write-Host "  exportUrl populated on retry $retry" -ForegroundColor Green
                        break
                    }
                    Write-Host "  Retry $retry/2: still empty..." -ForegroundColor Gray
                } catch {
                    Write-Host "  Retry $retry POLL ERROR: $($_.Exception.Message)" -ForegroundColor Red
                }
            }
        }

        if ($exportUrl) {
            # Download PDF
            try {
                Invoke-WebRequest -Uri $exportUrl -OutFile $outputFile
                $fileSize = [math]::Round((Get-Item $outputFile).Length / 1024)
                Write-Host "  PDF saved: $($handout.PdfName) ($($fileSize)KB)" -ForegroundColor Green
                $succeeded++
                $results += @{
                    num = $num
                    title = $handout.PdfName
                    status = "success"
                    gammaUrl = $gammaUrl
                    exportUrl = $exportUrl
                    pdfPath = $outputFile
                    credits = $creditsDeducted
                    sizeKB = $fileSize
                }
            } catch {
                Write-Host "  PDF DOWNLOAD ERROR: $($_.Exception.Message)" -ForegroundColor Red
                $failed++
                $results += @{
                    num = $num
                    title = $handout.PdfName
                    status = "download_error"
                    gammaUrl = $gammaUrl
                    exportUrl = $exportUrl
                    reason = $_.Exception.Message
                }
            }
        } else {
            Write-Host "  WARNING: No exportUrl after retries. Manual export: $gammaUrl" -ForegroundColor Yellow
            $noPdf++
            $results += @{
                num = $num
                title = $handout.PdfName
                status = "completed_no_export"
                gammaUrl = $gammaUrl
                generationId = $generationId
                reason = "exportUrl empty after 2 retries. Export manually from gammaUrl."
            }
        }

        # Log to JSONL
        $logEntry = @{
            title = $handout.PdfName
            generationId = $generationId
            gammaUrl = $gammaUrl
            exportUrl = $(if ($exportUrl) { $exportUrl } else { "" })
            creditsDeducted = $creditsDeducted
            creditsRemaining = $creditsRemaining
            timestamp = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
        } | ConvertTo-Json -Compress
        Add-Content -Path $resultsLog -Value $logEntry -Encoding UTF8

    } elseif ($status -eq "failed") {
        $errMsg = if ($result.error.message) { $result.error.message } else { $result.error }
        Write-Host "  FAILED: $errMsg" -ForegroundColor Red
        $failed++
        $results += @{ num = $num; title = $handout.PdfName; status = "failed"; reason = $errMsg }
    } else {
        Write-Host "  TIMEOUT after $($attempts * 5) seconds" -ForegroundColor Red
        $failed++
        $results += @{ num = $num; title = $handout.PdfName; status = "timeout"; generationId = $generationId }
    }

    # Rate limit buffer between submissions
    if ($i -lt ($total - 1)) {
        Write-Host "  Waiting 5s before next..." -ForegroundColor Gray
        Start-Sleep -Seconds 5
    }
}

# Summary
Write-Host ""
Write-Host "=== SUMMARY ===" -ForegroundColor Cyan
Write-Host "Succeeded (PDF downloaded): $succeeded / $total" -ForegroundColor Green
if ($noPdf -gt 0) { Write-Host "Completed but no PDF:       $noPdf / $total" -ForegroundColor Yellow }
if ($failed -gt 0) { Write-Host "Failed:                     $failed / $total" -ForegroundColor Red }
Write-Host "Results log: $resultsLog"
Write-Host ""

# Print result table
Write-Host "Results:" -ForegroundColor Cyan
foreach ($r in $results) {
    $statusColor = switch -Regex ($r.status) {
        "success" { "Green" }
        "completed" { "Yellow" }
        default { "Red" }
    }
    $line = "  [$($r.num)] $($r.title) - $($r.status)"
    if ($r.sizeKB) { $line += " ($($r.sizeKB)KB)" }
    if ($r.gammaUrl) { $line += " | $($r.gammaUrl)" }
    if ($r.reason) { $line += " | $($r.reason)" }
    Write-Host $line -ForegroundColor $statusColor
}

# List any that need manual export
$manualExport = $results | Where-Object { $_.status -eq "completed_no_export" }
if ($manualExport) {
    Write-Host ""
    Write-Host "=== MANUAL EXPORT NEEDED ===" -ForegroundColor Yellow
    foreach ($m in $manualExport) {
        Write-Host "  $($m.title): $($m.gammaUrl)" -ForegroundColor Yellow
    }
}
