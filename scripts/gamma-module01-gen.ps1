$key = [System.Environment]::GetEnvironmentVariable('GAMMA_API_KEY', 'User')
if (-not $key) {
    $envContent = Get-Content 'C:\Users\Derek DiCamillo\atlas\.env' -ErrorAction SilentlyContinue
    $keyLine = $envContent | Where-Object { $_ -match '^GAMMA_API_KEY=' }
    if ($keyLine) { $key = ($keyLine -split '=',2)[1].Trim().Trim('"') }
}

$inputText = [System.IO.File]::ReadAllText('C:\Users\Derek DiCamillo\atlas\scripts\gamma-inputs\module-01.md', [System.Text.Encoding]::UTF8)
# Remove BOM if present
if ($inputText.Length -gt 0 -and [int][char]$inputText[0] -eq 65279) {
    $inputText = $inputText.Substring(1)
}
# Remove null bytes
$inputText = $inputText -replace "`0", ""
Write-Host "Input length: $($inputText.Length) chars"

$additionalInstructions = "This is a CEU slide deck for licensed medical providers (NPs, PAs, MDs). Branding: The Medical Aesthetics Association (TMAA). Clean professional blue medical education design. Title slide with TMAA name and course title. One slide per major concept. Clinical pearls slides. Summary slide at end. Tables and bullet hierarchy. Evidence-based, no filler."

$bodyObj = @{
    inputText = $inputText
    textMode = "condense"
    format = "presentation"
    exportAs = "pptx"
    numCards = 22
    additionalInstructions = $additionalInstructions
    textOptions = @{
        amount = "detailed"
        tone = "Professional, evidence-based, clinical education. Authoritative but accessible to providers new to obesity medicine."
        audience = "Licensed medical providers (NPs, PAs, MDs) seeking CEU credit in GLP-1 obesity pharmacology"
        language = "en"
    }
    imageOptions = @{
        source = "noImages"
    }
    cardOptions = @{
        dimensions = "16x9"
    }
    themeId = "consultant"
}

$body = $bodyObj | ConvertTo-Json -Depth 5
$headers = @{
    "X-API-KEY" = $key
    "Content-Type" = "application/json"
}

Write-Host "Submitting Module 01 to Gamma..."
try {
    $response = Invoke-RestMethod -Uri "https://public-api.gamma.app/v1.0/generations" -Method POST -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -ContentType "application/json; charset=utf-8"
    $generationId = $response.generationId
    Write-Host "Generation ID: $generationId"
} catch {
    Write-Host "SUBMIT ERROR: $($_.Exception.Message)"
    Write-Host "Details: $($_.ErrorDetails.Message)"
    exit 1
}

# Poll for completion
$status = "pending"
$attempts = 0
Write-Host "Polling for completion..."
while ($status -eq "pending" -and $attempts -lt 72) {
    Start-Sleep -Seconds 5
    try {
        $result = Invoke-RestMethod -Uri "https://public-api.gamma.app/v1.0/generations/$generationId" -Headers @{ "X-API-KEY" = $key }
        $status = $result.status
        $attempts++
        if ($attempts % 6 -eq 0) { Write-Host "  Still processing... ($($attempts * 5)s)" }
    } catch {
        $attempts++
    }
}

if ($status -ne "completed") {
    Write-Host "TIMEOUT or error. Last status: $status"
    exit 1
}

# Extra poll to get export URLs
Start-Sleep -Seconds 3
$result = Invoke-RestMethod -Uri "https://public-api.gamma.app/v1.0/generations/$generationId" -Headers @{ "X-API-KEY" = $key }

Write-Host ""
Write-Host "=== COMPLETED ==="
Write-Host "Gamma URL: $($result.gammaUrl)"
Write-Host "PPTX URL:  $($result.pptxUrl)"
Write-Host "PDF URL:   $($result.pdfUrl)"
Write-Host "Credits:   $($result.credits.deducted) deducted, $($result.credits.remaining) remaining"

# Download PPTX
if ($result.pptxUrl) {
    $outDir = "C:\Users\Derek DiCamillo\OneDrive - PV MEDISPA LLC\MAA\GLP1-CEU\"
    if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
    $outFile = Join-Path $outDir "Module-01-Foundations-Slides.pptx"
    Invoke-WebRequest -Uri $result.pptxUrl -OutFile $outFile
    Write-Host "Downloaded: $outFile"
}

# Download PDF
if ($result.pdfUrl) {
    $outDir = "C:\Users\Derek DiCamillo\OneDrive - PV MEDISPA LLC\MAA\GLP1-CEU\"
    $outFile = Join-Path $outDir "Module-01-Foundations-Slides.pdf"
    Invoke-WebRequest -Uri $result.pdfUrl -OutFile $outFile
    Write-Host "Downloaded: $outFile"
}
