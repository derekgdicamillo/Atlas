$headers = @{
    "X-API-KEY" = $env:GAMMA_API_KEY
    "Content-Type" = "application/json"
}

# Minimal test payload
$body = @{
    inputText = "A simple test document about business planning"
    textMode = "generate"
    format = "document"
    numCards = 3
    textOptions = @{
        amount = "medium"
        tone = "Professional"
        audience = "Business leaders"
        language = "en"
    }
    imageOptions = @{
        source = "noImages"
    }
} | ConvertTo-Json -Depth 5

Write-Host "Sending request..."
Write-Host "Body: $body"

try {
    $response = Invoke-RestMethod -Uri "https://public-api.gamma.app/v1.0/generations" -Method POST -Headers $headers -Body $body
    Write-Host "Success!"
    $response | ConvertTo-Json -Depth 5
} catch {
    Write-Host "Error: $($_.Exception.Message)"
    Write-Host "Status: $($_.Exception.Response.StatusCode.value__)"
    try {
        $stream = $_.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        Write-Host "Body: $($reader.ReadToEnd())"
    } catch {
        Write-Host "No response body"
    }
}
