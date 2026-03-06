# Check how many times footer appears
$path = 'C:\Users\derek\OneDrive - PV MEDISPA LLC\03_VitalityUnchained\Course_PDFs\MOD11_Patient_Handouts\Patient Handout - Eating for Success on GLP-1 Therapy.md'
$text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)

$count = ([regex]::Matches($text, 'All rights reserved')).Count
Write-Host "Footer occurrences: $count"

# Show last 500 chars
$last = $text.Substring([Math]::Max(0, $text.Length - 500))
Write-Host "=== LAST 500 CHARS ==="
$bytes = [System.Text.Encoding]::UTF8.GetBytes($last)
foreach ($b in $bytes) {
    if ($b -gt 127) {
        Write-Host -NoNewline ("[{0}]" -f $b)
    } else {
        Write-Host -NoNewline ([char]$b)
    }
}
Write-Host ""
