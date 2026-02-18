$vaultRoot = "C:\Users\derek\OneDrive - PV MEDISPA LLC\PV Vault\02 - PV MediSpa\Programs + Course\GLP1 CME"
$tempDir = "C:\Users\derek\Projects\atlas\scripts\gamma-inputs"
$scriptDir = "C:\Users\derek\Projects\atlas\scripts"

# Create temp dir
if (-not (Test-Path $tempDir)) { New-Item -ItemType Directory -Path $tempDir | Out-Null }

# Helper to concat module files
function Build-ModuleInput {
    param([string]$ModuleDir, [string]$Title, [string]$OutputFile)

    $content = "# $Title`n`nGLP-1 Receptor Agonists for Obesity Management: A Comprehensive Provider Course`n`n---`n`n"
    $lessons = Get-ChildItem "$ModuleDir\Lesson*.md" | Sort-Object Name
    foreach ($lesson in $lessons) {
        $text = Get-Content $lesson.FullName -Raw -Encoding UTF8
        $content += "$text`n`n---`n`n"
    }
    Set-Content -Path $OutputFile -Value $content -Encoding UTF8
    Write-Host "Built: $OutputFile ($([math]::Round($content.Length/1024))KB)"
}

# Build all module inputs
$modules = @(
    @{ Dir = "Module 00 - Welcome & The 5 Pillars Framework"; Title = "Module 00: Welcome & The 5 Pillars Framework" },
    @{ Dir = "Module 01 - Foundations (Obesity Medicine & Incretin Physiology)"; Title = "Module 01: Foundations - Obesity Medicine & Incretin Physiology" },
    @{ Dir = "Module 02 - Medication Overview (GLP-1 RA vs Dual Agonists)"; Title = "Module 02: Medication Overview - GLP-1 RA vs Dual Agonists" },
    @{ Dir = "Module 03 - Patient Selection & Contraindications"; Title = "Module 03: Patient Selection & Contraindications" },
    @{ Dir = "Module 04 - Dosing, Titration & Practical Management"; Title = "Module 04: Dosing, Titration & Practical Management" },
    @{ Dir = "Module 05 - Adverse Effect Prevention & Management"; Title = "Module 05: Adverse Effect Prevention & Management" },
    @{ Dir = "Module 06 - Monitoring, Labs & Documentation"; Title = "Module 06: Monitoring, Labs & Documentation" },
    @{ Dir = "Module 07 - Special Populations"; Title = "Module 07: Special Populations" },
    @{ Dir = "Module 08 - Practice Implementation"; Title = "Module 08: Practice Implementation" },
    @{ Dir = "Module 09 - Clinical Frontier (Emerging Evidence)"; Title = "Module 09: Clinical Frontier - Emerging Evidence" },
    @{ Dir = "Module 10 - Practice Differentiation & Patient Systems"; Title = "Module 10: Practice Differentiation & Patient Systems" }
)

foreach ($m in $modules) {
    $num = $m.Dir.Substring(7, 2)
    Build-ModuleInput -ModuleDir "$vaultRoot\04_Course\$($m.Dir)" -Title $m.Title -OutputFile "$tempDir\module-$num.md"
}

# Build supplementary doc inputs
# Doc 12: Provider Quick Reference Compendium
$doc12Files = @(
    "03_Knowledge\Medications\Semaglutide One-Pager (Provider Quick Reference).md",
    "03_Knowledge\Medications\Tirzepatide One-Pager (Provider Quick Reference).md",
    "03_Knowledge\Medications\Retatrutide (investigational).md",
    "03_Knowledge\AdverseEffects\Algorithm - Nausea & Vomiting Management.md",
    "03_Knowledge\AdverseEffects\Algorithm - Constipation Management.md",
    "03_Knowledge\AdverseEffects\Algorithm - Diarrhea Management.md",
    "03_Knowledge\AdverseEffects\Algorithm - Gallbladder Symptoms Management.md",
    "03_Knowledge\AdverseEffects\Algorithm - Pancreatitis Recognition & Management.md",
    "03_Knowledge\AdverseEffects\Algorithm - Hypoglycemia Prevention & Management.md",
    "03_Knowledge\Label-Derived\Dosing & Titration - Semaglutide (label-derived).md",
    "03_Knowledge\Label-Derived\Dosing & Titration - Tirzepatide (label-derived).md",
    "03_Knowledge\Label-Derived\Missed Dose Rules - Semaglutide vs Tirzepatide - Label Summary.md",
    "03_Knowledge\Label-Derived\Drug Interactions - GLP-1 AOMs (label-derived).md",
    "03_Knowledge\Label-Derived\Storage & Handling - Semaglutide vs Tirzepatide (label-derived).md",
    "03_Knowledge\Label-Derived\Special Populations - GLP-1 AOMs (label-derived).md",
    "03_Knowledge\Protocols\Protocol - GLP-1 Initiation & Titration (generic).md"
)
$doc12Content = "# Provider Quick Reference Compendium`n`nGLP-1 AOM Clinical Reference Guide for Prescribing Providers`n`n---`n`n"
foreach ($f in $doc12Files) {
    $path = "$vaultRoot\$f"
    if (Test-Path $path) {
        $doc12Content += (Get-Content $path -Raw -Encoding UTF8) + "`n`n---`n`n"
    } else {
        Write-Host "MISSING: $f"
    }
}
Set-Content -Path "$tempDir\doc-12-quickref.md" -Value $doc12Content -Encoding UTF8
Write-Host "Built: doc-12-quickref.md ($([math]::Round($doc12Content.Length/1024))KB)"

# Doc 13: Clinical Documentation Toolkit
$doc13Files = @(
    "03_Knowledge\Documentation-Templates\Chart Note - GLP-1 Initial Visit.md",
    "03_Knowledge\Documentation-Templates\Chart Note - GLP-1 Follow-Up Visit.md",
    "03_Knowledge\Documentation-Templates\Documentation - Informed Consent (GLP-1 therapy) - Outline.md",
    "03_Knowledge\Documentation-Templates\Appeal Letter - GLP-1 Prior Auth Denial.md",
    "03_Knowledge\Documentation-Templates\Letter of Medical Necessity - GLP-1 AOM.md",
    "03_Knowledge\Compounding\Regulatory\Compounded GLP-1s - Regulatory Overview (US).md"
)
$doc13Content = "# Clinical Documentation Toolkit`n`nTemplates and Reference Documents for GLP-1 AOM Practice`n`n---`n`n"
foreach ($f in $doc13Files) {
    $path = "$vaultRoot\$f"
    if (Test-Path $path) {
        $doc13Content += (Get-Content $path -Raw -Encoding UTF8) + "`n`n---`n`n"
    } else {
        Write-Host "MISSING: $f"
    }
}
Set-Content -Path "$tempDir\doc-13-documentation.md" -Value $doc13Content -Encoding UTF8
Write-Host "Built: doc-13-documentation.md ($([math]::Round($doc13Content.Length/1024))KB)"

# Doc 14: Patient Education Resource Pack
$doc14Files = @(
    "05_Content\Patient-Handouts\Patient Handout - How to Give Your Injection.md",
    "05_Content\Patient-Handouts\Patient Handout - Eating for Success on GLP-1 Therapy.md",
    "05_Content\Patient-Handouts\Patient Handout - Managing Side Effects.md",
    "05_Content\Patient-Handouts\Patient Handout - What to Expect on Your Weight Loss Journey.md"
)
$doc14Content = "# Patient Education Resource Pack`n`nHandouts and Guides for GLP-1 Weight Loss Patients`n`n---`n`n"
foreach ($f in $doc14Files) {
    $path = "$vaultRoot\$f"
    if (Test-Path $path) {
        $doc14Content += (Get-Content $path -Raw -Encoding UTF8) + "`n`n---`n`n"
    } else {
        Write-Host "MISSING: $f"
    }
}
Set-Content -Path "$tempDir\doc-14-patient-education.md" -Value $doc14Content -Encoding UTF8
Write-Host "Built: doc-14-patient-education.md ($([math]::Round($doc14Content.Length/1024))KB)"

# Doc 15: Prescriber Cheat Sheet
$doc15Path = "$vaultRoot\03_Knowledge\Prescriber Cheat Sheet - GLP-1 AOM Rapid Reference.md"
if (Test-Path $doc15Path) {
    Copy-Item $doc15Path "$tempDir\doc-15-cheatsheet.md"
    Write-Host "Built: doc-15-cheatsheet.md"
} else {
    Write-Host "MISSING: Prescriber Cheat Sheet"
}

Write-Host "`n=== All input files built ==="
Get-ChildItem $tempDir -Name
