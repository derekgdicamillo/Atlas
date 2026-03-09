param(
    [string]$GenerationId = "9rZdiMN34vNScRXN2Zcjk"
)

$headers = @{
    "X-API-KEY" = $env:GAMMA_API_KEY
}

$status = "pending"
$attempts = 0
$maxAttempts = 60  # 5 minutes

while ($status -eq "pending" -and $attempts -lt $maxAttempts) {
    Start-Sleep -Seconds 5
    $attempts++

    try {
        $result = Invoke-RestMethod -Uri "https://public-api.gamma.app/v1.0/generations/$GenerationId" -Headers $headers
        $status = $result.status
        Write-Host "Attempt $attempts : Status = $status"

        if ($status -ne "pending") {
            Write-Host ""
            $result | ConvertTo-Json -Depth 5
        }
    } catch {
        Write-Host "Attempt $attempts : Error - $($_.Exception.Message)"
    }
}

if ($status -eq "pending") {
    Write-Host "Timed out after $maxAttempts attempts"
}
