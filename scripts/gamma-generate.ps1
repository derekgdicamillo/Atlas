param(
    [string]$Title,
    [string]$InputFile,
    [string]$OutputLog = "C:\Users\derek\OneDrive - PV MEDISPA LLC\PV Vault\02 - PV MediSpa\Programs + Course\GLP1 CME\05_Content\gamma-results.jsonl"
)

$apiKey = [System.Environment]::GetEnvironmentVariable('GAMMA_API_KEY', 'User')
if (-not $apiKey) {
    Write-Error "GAMMA_API_KEY not found in user environment"
    exit 1
}

$inputText = [System.IO.File]::ReadAllText($InputFile, [System.Text.Encoding]::UTF8)
# Remove BOM if present
if ($inputText.Length -gt 0 -and $inputText[0] -eq [char]0xFEFF) {
    $inputText = $inputText.Substring(1)
}
# Remove null bytes
$inputText = $inputText -replace "`0", ""
if ($inputText.Length -gt 50000) { $inputText = $inputText.Substring(0, 50000) }
Write-Host "  Input length: $($inputText.Length) chars"

$body = @{
    inputText = $inputText
    textMode = "preserve"
    format = "document"
    textOptions = @{
        amount = "detailed"
        tone = "Professional, evidence-based, clinical education"
        audience = "Physicians, NPs, PAs prescribing GLP-1 medications"
        language = "en"
    }
    imageOptions = @{
        source = "noImages"
    }
    cardOptions = @{
        dimensions = "letter"
    }
} | ConvertTo-Json -Depth 5

$headers = @{
    "X-API-KEY" = $apiKey
    "Content-Type" = "application/json"
}

Write-Host "Submitting: $Title ..."

try {
    $response = Invoke-RestMethod -Uri "https://public-api.gamma.app/v1.0/generations" -Method POST -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -ContentType "application/json; charset=utf-8"
    $generationId = $response.generationId
    Write-Host "  Generation ID: $generationId"
} catch {
    Write-Host "  SUBMIT ERROR: $($_.Exception.Message)"
    Write-Host "  Details: $($_.ErrorDetails.Message)"
    exit 1
}

# Poll for completion
$status = "pending"
$attempts = 0
while ($status -eq "pending" -and $attempts -lt 60) {
    Start-Sleep -Seconds 5
    try {
        $result = Invoke-RestMethod -Uri "https://public-api.gamma.app/v1.0/generations/$generationId" -Headers @{ "X-API-KEY" = $apiKey }
        $status = $result.status
        $attempts++
        if ($attempts % 6 -eq 0) { Write-Host "  Still processing... ($($attempts * 5)s)" }
    } catch {
        Write-Host "  POLL ERROR: $($_.Exception.Message)"
        $attempts++
    }
}

if ($status -eq "completed") {
    $url = $result.gammaUrl
    $creditsDeducted = $result.credits.deducted
    $creditsRemaining = $result.credits.remaining
    Write-Host "  DONE: $url (cost: $creditsDeducted credits, remaining: $creditsRemaining)"

    # Log result
    $logEntry = @{
        title = $Title
        generationId = $generationId
        gammaId = $result.gammaId
        url = $url
        creditsDeducted = $creditsDeducted
        creditsRemaining = $creditsRemaining
        timestamp = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    } | ConvertTo-Json -Compress
    Add-Content -Path $OutputLog -Value $logEntry -Encoding UTF8

    Write-Output $url
} elseif ($status -eq "failed") {
    Write-Host "  FAILED: $($result.error)"
    exit 1
} else {
    Write-Host "  TIMEOUT after $($attempts * 5) seconds (status: $status)"
    exit 1
}
