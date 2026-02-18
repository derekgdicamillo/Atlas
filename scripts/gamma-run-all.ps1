$scriptPath = "C:\Users\derek\Projects\atlas\scripts\gamma-generate.ps1"
$inputDir = "C:\Users\derek\Projects\atlas\scripts\gamma-inputs"

$documents = @(
    @{ Title = "Module 01: Foundations - Obesity Medicine and Incretin Physiology"; File = "module-01.md" },
    @{ Title = "Module 02: Medication Overview - GLP-1 RA vs Dual Agonists"; File = "module-02.md" },
    @{ Title = "Module 03: Patient Selection and Contraindications"; File = "module-03.md" },
    @{ Title = "Module 04: Dosing, Titration and Practical Management"; File = "module-04.md" },
    @{ Title = "Module 05: Adverse Effect Prevention and Management"; File = "module-05.md" },
    @{ Title = "Module 06: Monitoring, Labs and Documentation"; File = "module-06.md" },
    @{ Title = "Module 07: Special Populations"; File = "module-07.md" },
    @{ Title = "Module 08: Practice Implementation"; File = "module-08.md" },
    @{ Title = "Module 09: Clinical Frontier - Emerging Evidence"; File = "module-09.md" },
    @{ Title = "Module 10: Practice Differentiation and Patient Systems"; File = "module-10.md" },
    @{ Title = "Provider Quick Reference Compendium"; File = "doc-12-quickref.md" },
    @{ Title = "Clinical Documentation Toolkit"; File = "doc-13-documentation.md" },
    @{ Title = "Patient Education Resource Pack"; File = "doc-14-patient-education.md" },
    @{ Title = "Prescriber Cheat Sheet - GLP-1 AOM Rapid Reference"; File = "doc-15-cheatsheet.md" }
)

$total = $documents.Count
$current = 0

foreach ($doc in $documents) {
    $current++
    Write-Host "`n[$current/$total] =========================================="
    $inputFile = Join-Path $inputDir $doc.File

    if (-not (Test-Path $inputFile)) {
        Write-Host "SKIP: $($doc.File) not found"
        continue
    }

    & $scriptPath -Title $doc.Title -InputFile $inputFile

    if ($current -lt $total) {
        Write-Host "  Waiting 3s before next..."
        Start-Sleep -Seconds 3
    }
}

Write-Host "`n=== ALL DONE ==="
Write-Host "Results logged to gamma-results.jsonl"
