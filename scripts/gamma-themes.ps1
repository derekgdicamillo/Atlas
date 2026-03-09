$headers = @{
    "X-API-KEY" = $env:GAMMA_API_KEY
}
$response = Invoke-RestMethod -Uri "https://public-api.gamma.app/v1.0/themes?limit=10" -Headers $headers
$response | ConvertTo-Json -Depth 3
