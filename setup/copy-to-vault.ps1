$vault = "C:\Users\derek\OneDrive - PV MEDISPA LLC\PV Vault"
$srcDir = "C:\Users\derek\Projects\atlas\data\training\brunson-ofa"
$destDir = "$vault\02 - PV MediSpa\Training\Russell Brunson - OFA Expert"

# Create destination
New-Item -ItemType Directory -Force $destDir | Out-Null
Write-Host "Dest: $destDir"

# Map of files to copy with clean Obsidian-friendly names
$files = @(
    @{ src = "day-1-One-Funnel-Away.txt";       md = "Day 01 - One Funnel Away.md" }
    @{ src = "day-2-Offer-Hacking.txt";          md = "Day 02 - Offer Hacking.md" }
    @{ src = "day-3-Creating-Your-Offer.txt";    md = "Day 03 - Creating Your Offer.md" }
    @{ src = "day-4-The-ASK-Campaign.txt";       md = "Day 04 - The ASK Campaign.md" }
    @{ src = "day-5-Building-Your-Funnel.txt";   md = "Day 05 - Building Your Funnel.md" }
    @{ src = "day-6-The-Perfect-Webinar.txt";    md = "Day 06 - The Perfect Webinar.md" }
    @{ src = "day-7-The-VSL-Page.txt";           md = "Day 07 - The VSL Page.md" }
    @{ src = "day-8-The-Order-Form.txt";         md = "Day 08 - The Order Form.md" }
    @{ src = "day-9-Your-Membership-Site.txt";   md = "Day 09 - Your Membership Site.md" }
    @{ src = "day-10-Traffic.txt";               md = "Day 10 - Traffic.md" }
)

foreach ($f in $files) {
    $srcFile = Join-Path $srcDir $f.src
    $destFile = Join-Path $destDir $f.md

    if (-not (Test-Path $srcFile)) {
        Write-Host "  MISSING: $($f.src)"
        continue
    }

    # Read content and add YAML frontmatter + markdown header
    $content = Get-Content $srcFile -Raw
    $day = if ($f.src -match "day-(\d+)") { $Matches[1] } else { "?" }

    $markdown = @"
---
source: Russell Brunson - One Funnel Away Expert Challenge
day: $day
type: transcript
tags: [marketing, funnels, brunson, ofa]
---

# $($f.md -replace '\.md$','')

> Transcript from Russell Brunson's One Funnel Away Expert Challenge (ClickFunnels)

$content
"@

    Set-Content -Path $destFile -Value $markdown -Encoding UTF8
    $kb = [math]::Round((Get-Item $destFile).Length / 1KB, 1)
    Write-Host "  OK: $($f.md) ($kb KB)"
}

Write-Host "`nDone. Files in vault:"
Get-ChildItem $destDir | ForEach-Object {
    Write-Host "  $($_.Name)"
}
