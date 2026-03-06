# Probe a completed generation to see what fields are returned
$apiKey = [System.Environment]::GetEnvironmentVariable('GAMMA_API_KEY', 'User')
if (-not $apiKey) {
    Write-Error "GAMMA_API_KEY not found"
    exit 1
}

# Use one of the generation IDs from previous run
$genId = 'WKLNLmQRLUo7L7UlhSiCL'

$result = Invoke-RestMethod -Uri "https://public-api.gamma.app/v1.0/generations/$genId" -Headers @{ "X-API-KEY" = $apiKey }
Write-Host "Full response:"
$result | ConvertTo-Json -Depth 5
