# append-footer.ps1
# Append copyright footer to all 12 patient handout markdown files
# Re-run safe: skips files that already have the footer

$inputDir = 'C:\Users\derek\OneDrive - PV MEDISPA LLC\03_VitalityUnchained\Course_PDFs\MOD11_Patient_Handouts'

# Use actual Unicode characters
$copyright = [char]0x00A9   # ©
$trademark = [char]0x2122   # ™

$footerBlock = "`r`n---`r`n$copyright 2026 PV MediSpa and Weight Loss. The 5 Pillars of Functional Medical Weight Loss$trademark is a trademark of PV MediSpa and Weight Loss LLC. All rights reserved.`r`n"

$files = Get-ChildItem $inputDir -Filter '*.md'
$added = 0
$skipped = 0

foreach ($f in $files) {
    $content = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)

    # Remove any broken previous footer attempt (literal u{00A9} etc.)
    $content = $content -replace '(?s)\r?\n\r?\n---\r?\nu\{00A9\}.*?All rights reserved\.\r?\n?$', ''
    $content = $content.TrimEnd()

    # Check if correct footer already exists (actual copyright symbol)
    if ($content -match "$([regex]::Escape($copyright)) 2026 PV MediSpa") {
        Write-Host "SKIP (already has footer): $($f.Name)" -ForegroundColor Gray
        $skipped++
        continue
    }

    # Append footer
    $content = $content + "`r`n`r`n" + $footerBlock
    [System.IO.File]::WriteAllText($f.FullName, $content, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "ADDED footer: $($f.Name)" -ForegroundColor Green
    $added++
}

Write-Host ""
Write-Host "Done. Added: $added, Skipped: $skipped, Total: $($files.Count)" -ForegroundColor Cyan
