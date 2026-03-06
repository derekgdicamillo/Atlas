# gamma-handouts-regen.ps1
# Regenerate 12 patient handout DOCUMENTS via Gamma API (no PDF download)
# Returns Gamma URLs for manual download

$inputDir = "C:\Users\derek\OneDrive - PV MEDISPA LLC\03_VitalityUnchained\Course_PDFs\MOD11_Patient_Handouts"
$resultsLog = "C:\Users\derek\Projects\atlas\scripts\gamma-handout-regen-results.jsonl"

$apiKey = [System.Environment]::GetEnvironmentVariable('GAMMA_API_KEY', 'User')
if (-not $apiKey) {
    Write-Error "GAMMA_API_KEY not found. Set with: [System.Environment]::SetEnvironmentVariable('GAMMA_API_KEY', 'your-key', 'User')"
    exit 1
}

$footer = "`n`n---`n`n*Copyright 2026 PV MediSpa and Weight Loss. The 5 Pillars of Functional Medical Weight Loss is a trademark of PV MediSpa and Weight Loss LLC. All rights reserved.*"

# Ordered handout list matching PE-01 through PE-12
$handouts = @(
    @{ File = "Patient Handout - Eating for Success on GLP-1 Therapy.md"; Title = "PE-01 Eating for Success on GLP-1 Therapy" },
    @{ File = "Patient Handout - How to Give Your Weekly Injection.md"; Title = "PE-02 How to Give Your Weekly Injection" },
    @{ File = "Patient Handout - Managing Side Effects.md"; Title = "PE-03 Managing Side Effects" },
    @{ File = "Patient Handout - What to Expect on Your Weight Loss Journey.md"; Title = "PE-04 What to Expect on Your Weight Loss Journey" },
    @{ File = "Patient Handout - Lab Monitoring Guide.md"; Title = "PE-05 Lab Monitoring Guide" },
    @{ File = "Patient Handout - Insurance and Cost Navigation Guide.md"; Title = "PE-06 Insurance and Cost Navigation Guide" },
    @{ File = "Patient Handout - Long-Term Maintenance and What Happens After.md"; Title = "PE-07 Long-Term Maintenance and What Happens After" },
    @{ File = "Patient Handout - Missed Dose Quick Reference Card.md"; Title = "PE-08 Missed Dose Quick Reference Card" },
    @{ File = "Patient Handout - Pre-Treatment Checklist.md"; Title = "PE-09 Pre-Treatment Checklist" },
    @{ File = "Patient Handout - Red Flags and When to Call.md"; Title = "PE-10 Red Flags and When to Call" },
    @{ File = "Patient Handout - Semaglutide vs Tirzepatide Comparison.md"; Title = "PE-11 Semaglutide vs Tirzepatide Comparison" },
    @{ File = "Patient Handout - Special Populations Quick Guide.md"; Title = "PE-12 Special Populations Quick Guide" }
)

$headers = @{
    "X-API-KEY" = $apiKey
    "Content-Type" = "application/json"
}

$total = $handouts.Count
$results = @()

Write-Host "=== Gamma Patient Handout DOCUMENT Regeneration ===" -ForegroundColor Cyan
Write-Host "Input:  $inputDir"
Write-Host "Format: document (no PDF export)"
Write-Host "Handouts: $total"
Write-Host ""

# Clear old results log
if (Test-Path $resultsLog) { Remove-Item $resultsLog -Force }

for ($i = 0; $i -lt $total; $i++) {
    $handout = $handouts[$i]
    $num = $i + 1
    $inputFile = Join-Path $inputDir $handout.File

    Write-Host "[$num/$total] $($handout.Title)" -ForegroundColor Yellow

    if (-not (Test-Path $inputFile)) {
        Write-Host "  SKIP: File not found: $inputFile" -ForegroundColor Red
        $results += @{ num = $num; title = $handout.Title; status = "skipped"; reason = "file not found"; gammaUrl = "" }
        continue
    }

    # Read and clean input
    $inputText = [System.IO.File]::ReadAllText($inputFile, [System.Text.Encoding]::UTF8)
    if ($inputText.Length -gt 0 -and $inputText[0] -eq [char]0xFEFF) {
        $inputText = $inputText.Substring(1)
    }
    $inputText = $inputText -replace "`0", ""

    # Strip YAML frontmatter
    if ($inputText -match "(?s)^---\r?\n.*?\r?\n---\r?\n(.*)$") {
        $inputText = $Matches[1].TrimStart()
    }

    # Append copyright footer
    $inputText = $inputText + $footer

    if ($inputText.Length -gt 50000) { $inputText = $inputText.Substring(0, 50000) }
    Write-Host "  Input: $($inputText.Length) chars"

    # Build request body
    $body = @{
        inputText = $inputText
        textMode = "preserve"
        format = "document"
        additionalInstructions = "This is a patient education handout for PV MediSpa and Weight Loss, a medical weight loss clinic. Format as a clean, professional document on letter-size pages. Preserve original structure exactly. Include this copyright footer at the bottom of every page: '(c) 2026 PV MediSpa and Weight Loss. The 5 Pillars of Functional Medical Weight Loss is a trademark of PV MediSpa and Weight Loss LLC. All rights reserved.' Do NOT add filler content or decorative images. Keep it clean and readable."
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
    $generationId = $null
    try {
        $response = Invoke-RestMethod -Uri "https://public-api.gamma.app/v1.0/generations" `
            -Method POST -Headers $headers `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
            -ContentType "application/json; charset=utf-8"
        $generationId = $response.generationId
        Write-Host "  Submitted: $generationId"
    } catch {
        $errMsg = $_.Exception.Message
        $errDetail = $_.ErrorDetails.Message
        Write-Host "  SUBMIT ERROR: $errMsg" -ForegroundColor Red
        if ($errDetail) { Write-Host "  Detail: $errDetail" -ForegroundColor Red }
        $results += @{ num = $num; title = $handout.Title; status = "submit_error"; reason = $errMsg; gammaUrl = "" }
        continue
    }

    # Poll for completion (max 60 seconds per task spec)
    $status = "pending"
    $attempts = 0
    $maxAttempts = 12  # 12 x 5s = 60s max
    $result = $null

    while ($status -eq "pending" -and $attempts -lt $maxAttempts) {
        Start-Sleep -Seconds 5
        $attempts++
        try {
            $result = Invoke-RestMethod -Uri "https://public-api.gamma.app/v1.0/generations/$generationId" `
                -Headers @{ "X-API-KEY" = $apiKey }
            $status = $result.status
            if ($attempts % 3 -eq 0) { Write-Host "  Polling... ($($attempts * 5)s)" -ForegroundColor Gray }
        } catch {
            Write-Host "  POLL ERROR: $($_.Exception.Message)" -ForegroundColor Red
        }
    }

    if ($status -eq "completed") {
        $gammaUrl = $result.gammaUrl
        $creditsDeducted = $result.credits.deducted
        $creditsRemaining = $result.credits.remaining
        Write-Host "  DONE: $gammaUrl" -ForegroundColor Green
        Write-Host "  Credits: -$creditsDeducted (remaining: $creditsRemaining)"
        $results += @{
            num = $num
            title = $handout.Title
            status = "completed"
            gammaUrl = $gammaUrl
            generationId = $generationId
            creditsDeducted = $creditsDeducted
            creditsRemaining = $creditsRemaining
        }

        # Log to JSONL
        $logEntry = @{
            title = $handout.Title
            generationId = $generationId
            gammaUrl = $gammaUrl
            creditsDeducted = $creditsDeducted
            creditsRemaining = $creditsRemaining
            timestamp = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
        } | ConvertTo-Json -Compress
        Add-Content -Path $resultsLog -Value $logEntry -Encoding UTF8

    } elseif ($status -eq "failed") {
        $errMsg = if ($result.error.message) { $result.error.message } else { "$($result.error)" }
        Write-Host "  FAILED: $errMsg" -ForegroundColor Red
        $results += @{ num = $num; title = $handout.Title; status = "failed"; reason = $errMsg; gammaUrl = "" }
    } else {
        Write-Host "  TIMEOUT (60s) - skipping. Generation ID: $generationId" -ForegroundColor Red
        $results += @{ num = $num; title = $handout.Title; status = "timeout"; generationId = $generationId; gammaUrl = "" }
    }

    # Rate limit buffer
    if ($i -lt ($total - 1)) {
        Write-Host "  Waiting 3s..." -ForegroundColor Gray
        Start-Sleep -Seconds 3
    }
}

# Summary
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "=== RESULTS SUMMARY ===" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host ("{0,-8} {1,-55} {2,-12} {3}" -f "Number", "Title", "Status", "Gamma URL")
Write-Host ("{0,-8} {1,-55} {2,-12} {3}" -f "------", "-----", "------", "---------")

foreach ($r in $results) {
    $statusColor = switch ($r.status) {
        "completed" { "Green" }
        "timeout"   { "Yellow" }
        default     { "Red" }
    }
    $line = "{0,-8} {1,-55} {2,-12} {3}" -f $r.num, $r.title, $r.status, $r.gammaUrl
    Write-Host $line -ForegroundColor $statusColor
}

$completedCount = ($results | Where-Object { $_.status -eq "completed" }).Count
$failedCount = ($results | Where-Object { $_.status -ne "completed" }).Count
Write-Host ""
Write-Host "Completed: $completedCount / $total" -ForegroundColor Green
if ($failedCount -gt 0) { Write-Host "Failed/Timeout: $failedCount / $total" -ForegroundColor Red }
Write-Host "Results log: $resultsLog"
