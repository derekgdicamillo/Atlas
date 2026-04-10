# Setup elevated PM2 scheduled task
# MUST be run as Administrator (right-click PowerShell > Run as Administrator)

# Check for admin
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERROR: This script must be run as Administrator!" -ForegroundColor Red
    Write-Host "Right-click PowerShell > Run as Administrator, then run this script again." -ForegroundColor Yellow
    exit 1
}

# Remove old non-elevated Run registry entry
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "PM2" -ErrorAction SilentlyContinue
Write-Host "Removed old PM2 Run registry entry (non-elevated)" -ForegroundColor Yellow

# Create scheduled task that runs pm2 resurrect at logon with highest privileges
$action = New-ScheduledTaskAction `
    -Execute "C:\Program Files\nodejs\node.exe" `
    -Argument "`"$env:APPDATA\npm\node_modules\pm2\bin\pm2`" resurrect" `
    -WorkingDirectory "$env:USERPROFILE\atlas"

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -RunLevel Highest `
    -LogonType Interactive

Register-ScheduledTask `
    -TaskName "PM2 Atlas Elevated" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Start pm2 with elevated privileges on logon" `
    -Force

Write-Host "Created 'PM2 Atlas Elevated' scheduled task with highest privileges" -ForegroundColor Green
Write-Host "PM2 will now run elevated on every logon" -ForegroundColor Green
