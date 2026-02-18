param([string]$GenId)
$apiKey = [System.Environment]::GetEnvironmentVariable("GAMMA_API_KEY", "User")
$result = Invoke-RestMethod -Uri "https://public-api.gamma.app/v1.0/generations/$GenId" -Headers @{ "X-API-KEY" = $apiKey }
$result | ConvertTo-Json -Depth 5
