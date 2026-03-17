#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Atlas Migration Bootstrap - Beelink SER9 Setup
    Run this on the NEW machine to set up Atlas from scratch.

.DESCRIPTION
    Installs all runtimes, tools, and services needed for Atlas 24/7 operation.
    Designed for Windows 11 Pro on Beelink SER9.

.NOTES
    Author: Atlas
    Date: 2026-03-16
    Prerequisites: Windows 11 Pro, internet connection, admin PowerShell
#>

param(
    [switch]$DryRun,
    [switch]$SkipReboot
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # Speed up downloads

# --- Configuration ---
$ATLAS_DIR = "C:\Users\derek\Projects\atlas"
$PROJECTS_DIR = "C:\Users\derek\Projects"
$ENV_SOURCE = "YOULL_COPY_THIS_MANUALLY"  # Never automate secrets transfer

function Write-Step {
    param([string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Write-OK {
    param([string]$Message)
    Write-Host "    [OK] $Message" -ForegroundColor Green
}

function Write-Skip {
    param([string]$Message)
    Write-Host "    [SKIP] $Message" -ForegroundColor Yellow
}

function Test-Command {
    param([string]$Command)
    return [bool](Get-Command $Command -ErrorAction SilentlyContinue)
}

# ============================================================
# PHASE 1: Windows Configuration
# ============================================================
Write-Step "Phase 1: Windows Configuration"

# Enable OpenSSH Server
$sshServer = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
if ($sshServer.State -ne 'Installed') {
    Write-Step "Installing OpenSSH Server..."
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
    Start-Service sshd
    Set-Service -Name sshd -StartupType Automatic
    # Set default shell to PowerShell
    New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value "C:\Program Files\PowerShell\7\pwsh.exe" -PropertyType String -Force
    Write-OK "OpenSSH Server installed and running"
} else {
    Start-Service sshd -ErrorAction SilentlyContinue
    Set-Service -Name sshd -StartupType Automatic
    Write-Skip "OpenSSH Server already installed"
}

# Firewall rule for SSH
$sshRule = Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
if (-not $sshRule) {
    New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" `
        -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
    Write-OK "Firewall rule added for SSH"
} else {
    Write-Skip "SSH firewall rule exists"
}

# Disable sleep/hibernate (this is a server)
Write-Step "Configuring power settings (always-on server)..."
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 30  # Screen off after 30 min is fine
powercfg /hibernate off
Write-OK "Sleep/hibernate disabled, monitor timeout 30 min"

# Auto-login (so Atlas starts on boot even without keyboard/monitor)
Write-Step "NOTE: Configure auto-login manually after setup"
Write-Host "    Run: netplwiz -> uncheck 'Users must enter a username and password'" -ForegroundColor Yellow

# ============================================================
# PHASE 2: Package Managers & Runtimes
# ============================================================
Write-Step "Phase 2: Installing Runtimes"

# Winget (should be preinstalled on Win11)
if (-not (Test-Command "winget")) {
    Write-Host "    [ERROR] winget not found. Install App Installer from Microsoft Store." -ForegroundColor Red
    exit 1
}

# Git
if (-not (Test-Command "git")) {
    Write-Step "Installing Git..."
    winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    Write-OK "Git installed"
} else {
    Write-Skip "Git already installed ($(git --version))"
}

# Node.js LTS
if (-not (Test-Command "node")) {
    Write-Step "Installing Node.js LTS..."
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    Write-OK "Node.js installed"
} else {
    Write-Skip "Node.js already installed ($(node --version))"
}

# Bun
if (-not (Test-Command "bun")) {
    Write-Step "Installing Bun..."
    irm bun.sh/install.ps1 | iex
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    Write-OK "Bun installed"
} else {
    Write-Skip "Bun already installed ($(bun --version))"
}

# Python
if (-not (Test-Command "python")) {
    Write-Step "Installing Python..."
    winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    Write-OK "Python installed"
} else {
    Write-Skip "Python already installed ($(python --version))"
}

# pm2 (global)
if (-not (Test-Command "pm2")) {
    Write-Step "Installing pm2..."
    npm install -g pm2
    # Windows startup script
    npm install -g pm2-windows-startup
    pm2-startup install
    Write-OK "pm2 installed with Windows startup"
} else {
    Write-Skip "pm2 already installed"
}

# ============================================================
# PHASE 3: Tools & Services
# ============================================================
Write-Step "Phase 3: Tools & Services"

# Tailscale
$tailscale = Get-Package -Name "Tailscale*" -ErrorAction SilentlyContinue
if (-not $tailscale) {
    Write-Step "Installing Tailscale..."
    winget install --id tailscale.tailscale -e --accept-source-agreements --accept-package-agreements
    Write-OK "Tailscale installed. Run 'tailscale up' to authenticate."
    Write-Host "    IMPORTANT: Also install Tailscale on your current PC and phone" -ForegroundColor Yellow
} else {
    Write-Skip "Tailscale already installed"
}

# Claude Code CLI
if (-not (Test-Command "claude")) {
    Write-Step "Installing Claude Code..."
    npm install -g @anthropic-ai/claude-code
    Write-OK "Claude Code installed"
} else {
    Write-Skip "Claude Code already installed"
}

# VS Code (optional but useful for remote dev)
if (-not (Test-Command "code")) {
    Write-Step "Installing VS Code..."
    winget install --id Microsoft.VisualStudioCode -e --accept-source-agreements --accept-package-agreements
    Write-OK "VS Code installed"
} else {
    Write-Skip "VS Code already installed"
}

# ============================================================
# PHASE 4: Atlas Repository
# ============================================================
Write-Step "Phase 4: Atlas Repository Setup"

if (-not (Test-Path $PROJECTS_DIR)) {
    New-Item -ItemType Directory -Path $PROJECTS_DIR -Force | Out-Null
}

if (-not (Test-Path "$ATLAS_DIR\.git")) {
    Write-Step "Cloning Atlas repo..."
    git clone https://github.com/derekgdicamillo/atlas.git $ATLAS_DIR
    Write-OK "Atlas cloned to $ATLAS_DIR"
} else {
    Write-Skip "Atlas repo already exists at $ATLAS_DIR"
    Set-Location $ATLAS_DIR
    git pull origin master
    Write-OK "Atlas repo updated"
}

Set-Location $ATLAS_DIR

# Install dependencies
Write-Step "Installing Atlas dependencies..."
bun install
Write-OK "Dependencies installed"

# ============================================================
# PHASE 5: Environment & Secrets
# ============================================================
Write-Step "Phase 5: Environment Setup"

if (-not (Test-Path "$ATLAS_DIR\.env")) {
    Write-Host @"

    ============================================
    MANUAL STEP: Copy .env file
    ============================================

    Option A (Tailscale): From your current PC, run:
      scp C:\Users\derek\Projects\atlas\.env derek@<beelink-tailscale-ip>:$ATLAS_DIR\.env

    Option B (USB): Copy .env to USB drive, plug into Beelink, copy to $ATLAS_DIR

    Option C (OneDrive): Temporarily copy to OneDrive, then delete after transfer

    DO NOT email, Slack, or paste .env contents anywhere.
    ============================================

"@ -ForegroundColor Yellow
} else {
    Write-OK ".env file exists"
}

# ============================================================
# PHASE 6: MCP Servers
# ============================================================
Write-Step "Phase 6: MCP Server Dependencies"

# Check for .mcp.json
if (Test-Path "$ATLAS_DIR\.mcp.json") {
    Write-OK ".mcp.json found, MCP servers will initialize on first Claude Code run"
} else {
    Write-Host "    [WARN] No .mcp.json found. Copy from current machine." -ForegroundColor Yellow
}

# ============================================================
# PHASE 7: OneDrive
# ============================================================
Write-Step "Phase 7: OneDrive Setup"

Write-Host @"

    ============================================
    MANUAL STEP: OneDrive for Business
    ============================================

    1. Sign in to OneDrive with derek@pvmedispa.com
    2. Let it sync C:\Users\derek\OneDrive - PV MEDISPA LLC\
    3. Wait for initial sync to complete
    4. Verify: Test-Path "C:\Users\derek\OneDrive - PV MEDISPA LLC\"

    Atlas uses OneDrive for file sharing via email.
    ============================================

"@ -ForegroundColor Yellow

# ============================================================
# PHASE 8: Start Atlas
# ============================================================
Write-Step "Phase 8: Atlas Startup"

if (Test-Path "$ATLAS_DIR\.env") {
    Write-Step "Starting Atlas via pm2..."
    Set-Location $ATLAS_DIR
    pm2 start ecosystem.config.cjs --only atlas
    pm2 save
    Write-OK "Atlas is running! Check: pm2 logs atlas"
} else {
    Write-Host "    [WAIT] .env not found yet. After copying .env, run:" -ForegroundColor Yellow
    Write-Host "    cd $ATLAS_DIR && pm2 start ecosystem.config.cjs --only atlas && pm2 save" -ForegroundColor White
}

# ============================================================
# PHASE 9: Verification
# ============================================================
Write-Step "Phase 9: Verification Checklist"

$checks = @(
    @{ Name = "Git"; Test = { Test-Command "git" } },
    @{ Name = "Node.js"; Test = { Test-Command "node" } },
    @{ Name = "Bun"; Test = { Test-Command "bun" } },
    @{ Name = "Python"; Test = { Test-Command "python" } },
    @{ Name = "pm2"; Test = { Test-Command "pm2" } },
    @{ Name = "Claude Code"; Test = { Test-Command "claude" } },
    @{ Name = "SSH Server"; Test = { (Get-Service sshd -ErrorAction SilentlyContinue).Status -eq 'Running' } },
    @{ Name = "Tailscale"; Test = { Test-Command "tailscale" } },
    @{ Name = "Atlas repo"; Test = { Test-Path "$ATLAS_DIR\package.json" } },
    @{ Name = ".env file"; Test = { Test-Path "$ATLAS_DIR\.env" } },
    @{ Name = "OneDrive synced"; Test = { Test-Path "C:\Users\derek\OneDrive - PV MEDISPA LLC\" } }
)

Write-Host ""
foreach ($check in $checks) {
    $result = & $check.Test
    if ($result) {
        Write-Host "    [PASS] $($check.Name)" -ForegroundColor Green
    } else {
        Write-Host "    [FAIL] $($check.Name)" -ForegroundColor Red
    }
}

# ============================================================
# POST-MIGRATION: Remote Access Setup
# ============================================================
Write-Host @"

============================================
POST-MIGRATION: Connect from your desktop
============================================

1. Install Tailscale on your current PC:
   winget install tailscale.tailscale
   tailscale up

2. Find the Beelink's Tailscale hostname:
   tailscale status  (on this machine)

3. SSH from your desktop:
   ssh derek@<beelink-hostname>

4. Claude Code remote (from your desktop):
   claude --ssh derek@<beelink-hostname>

5. VS Code Remote SSH:
   - Install "Remote - SSH" extension
   - Connect to derek@<beelink-hostname>
   - Open C:\Users\derek\Projects\atlas

6. (Optional) Set up SSH key auth:
   ssh-keygen -t ed25519
   ssh-copy-id derek@<beelink-hostname>

============================================
"@ -ForegroundColor Cyan

Write-Host "`nBootstrap complete! $(Get-Date)" -ForegroundColor Green
