$lines = Get-Content 'C:\Users\derek\Projects\atlas\.env'
$tok = ""
$acct = ""
foreach ($l in $lines) {
    if ($l -match '^META_ACCESS_TOKEN=(.+)') { $tok = $Matches[1].Trim() }
    if ($l -match '^META_AD_ACCOUNT_ID=(.+)') { $acct = $Matches[1].Trim() }
}

Write-Output "Account: $acct | Token length: $($tok.Length)"

# Pull active ads with creative details
$cleanAcct = $acct -replace '^act_', ''
$url = "https://graph.facebook.com/v21.0/act_$cleanAcct/ads?fields=name,status,effective_status,creative{name,title,body,image_url,thumbnail_url,call_to_action_type,object_story_spec},insights.date_preset(last_30d){impressions,clicks,ctr,cpc,spend,actions,cost_per_action_type,frequency,reach}&effective_status=[%27ACTIVE%27]&limit=50&access_token=$tok"

try {
    $response = Invoke-RestMethod -Uri $url -Method GET -TimeoutSec 30
    Write-Output "`n=== ACTIVE ADS ==="
    $response | ConvertTo-Json -Depth 10
} catch {
    Write-Output "Error fetching active ads: $_"
}

# Pull paused/campaign-paused ads
$url2 = "https://graph.facebook.com/v21.0/act_$cleanAcct/ads?fields=name,status,effective_status,creative{name,title,body,image_url,thumbnail_url,call_to_action_type},insights.date_preset(last_30d){impressions,clicks,ctr,cpc,spend,actions,cost_per_action_type,frequency,reach}&effective_status=[%27PAUSED%27,%27CAMPAIGN_PAUSED%27,%27ADSET_PAUSED%27]&limit=50&access_token=$tok"

try {
    $response2 = Invoke-RestMethod -Uri $url2 -Method GET -TimeoutSec 30
    Write-Output "`n=== PAUSED ADS ==="
    $response2 | ConvertTo-Json -Depth 10
} catch {
    Write-Output "Error fetching paused ads: $_"
}
