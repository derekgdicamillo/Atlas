# Find Obsidian vault location
# Check common locations
$locations = @(
    "C:\Users\derek\Obsidian",
    "C:\Users\derek\Documents\Obsidian",
    "C:\Users\derek\OneDrive\Obsidian",
    "C:\Users\derek\Notes",
    "C:\Users\derek\Documents\Notes"
)

foreach ($loc in $locations) {
    if (Test-Path $loc) {
        Write-Host "FOUND: $loc"
        Get-ChildItem $loc -Directory -Depth 0 | ForEach-Object {
            Write-Host "  Vault: $($_.FullName)"
        }
    }
}

# Also check for .obsidian directories (marker of a vault)
Write-Host "`nSearching for .obsidian config dirs..."
Get-ChildItem "C:\Users\derek" -Directory -Filter ".obsidian" -Recurse -Depth 3 -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  Vault at: $($_.Parent.FullName)"
}

# Check if Obsidian is installed and read its config
$obsidianConfig = "$env:APPDATA\obsidian\obsidian.json"
if (Test-Path $obsidianConfig) {
    Write-Host "`nObsidian config: $obsidianConfig"
    Get-Content $obsidianConfig | Write-Host
}
