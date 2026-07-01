# qcp installer for Windows
# Usage: irm https://raw.githubusercontent.com/Moduna-AI/qcp/main/scripts/install.ps1 | iex

param(
    [string]$Version = "latest",
    [string]$InstallDir = "$env:LOCALAPPDATA\qcp\bin"
)

$ErrorActionPreference = "Stop"

$Repo = "Moduna-AI/qcp"
$BinaryName = "qcp.exe"

# ── Helpers ────────────────────────────────────────────────────────────────────

function Write-Info    { Write-Host "  → $args" -ForegroundColor Cyan }
function Write-Success { Write-Host "  ✓ $args" -ForegroundColor Green }
function Write-Warn    { Write-Host "  ⚠ $args" -ForegroundColor Yellow }
function Write-Fail    { Write-Host "  ✗ $args" -ForegroundColor Red; exit 1 }

# ── Detect architecture ────────────────────────────────────────────────────────

function Get-Architecture {
    $arch = (Get-CimInstance Win32_ComputerSystem).SystemType
    if ($arch -match "x64") { return "x64" }
    if ($arch -match "ARM") { Write-Fail "ARM Windows is not yet supported" }
    return "x64"
}

# ── Resolve version ────────────────────────────────────────────────────────────

function Resolve-Version {
    if ($Version -ne "latest") { return $Version }

    Write-Info "Fetching latest release..."
    try {
        $release = Invoke-RestMethod `
            -Uri "https://api.github.com/repos/$Repo/releases/latest" `
            -Headers @{ "User-Agent" = "qcp-installer" }
        return $release.tag_name -replace "^v", ""
    } catch {
        Write-Fail "Could not fetch latest version: $_"
    }
}

# ── Download binary ────────────────────────────────────────────────────────────

function Download-Binary($version, $arch) {
    $fileName = "qcp-windows-${arch}.exe"
    $url = "https://github.com/$Repo/releases/download/v$version/$fileName"
    $tmpFile = [System.IO.Path]::GetTempFileName() + ".exe"

    Write-Info "Downloading $fileName..."
    try {
        $ProgressPreference = "SilentlyContinue"
        Invoke-WebRequest -Uri $url -OutFile $tmpFile -UseBasicParsing
        return $tmpFile
    } catch {
        Write-Fail "Download failed from ${url}: $_"
    }
}

# ── Install ────────────────────────────────────────────────────────────────────

function Install-Binary($tmpFile, $version) {
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }

    $target = Join-Path $InstallDir $BinaryName
    Copy-Item $tmpFile $target -Force
    Remove-Item $tmpFile -Force

    Write-Success "Installed qcp to $target"
    return $target
}

# ── Add to PATH ────────────────────────────────────────────────────────────────

function Add-ToPath {
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($userPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable(
            "PATH",
            "$userPath;$InstallDir",
            "User"
        )
        $env:PATH = "$env:PATH;$InstallDir"
        Write-Success "Added $InstallDir to PATH"
        Write-Warn "Restart your terminal for PATH changes to take effect"
    } else {
        Write-Success "$InstallDir already in PATH"
    }
}

# ── Verify installation ────────────────────────────────────────────────────────

function Test-Installation($target) {
    try {
        $output = & $target "--version" 2>&1
        if ($output -match "\d+\.\d+\.\d+") {
            Write-Success "Verified: $output"
            return $true
        }
    } catch {}
    Write-Warn "Binary installed but verification failed"
    return $false
}

# ── Main ───────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  qcp — Query Companion" -ForegroundColor Cyan -NoNewline
Write-Host " (Windows installer)" -ForegroundColor DarkGray
Write-Host ""

# Check existing
if (Get-Command qcp -ErrorAction SilentlyContinue) {
    $existing = (qcp --version 2>&1) | Select-Object -First 1
    Write-Info "Existing installation found: $existing"
}

$arch = Get-Architecture
Write-Info "Detected architecture: $arch"

$resolvedVersion = Resolve-Version
Write-Success "Installing qcp v$resolvedVersion"

$tmpFile = Download-Binary $resolvedVersion $arch
$target  = Install-Binary $tmpFile $resolvedVersion
Add-ToPath
Test-Installation $target | Out-Null

Write-Host ""
Write-Success "qcp v$resolvedVersion installed!"
Write-Host ""
Write-Host "  Get started:" -ForegroundColor White
Write-Host ""
Write-Host "    qcp init" -ForegroundColor DarkGray
Write-Host "    qcp auth" -ForegroundColor DarkGray
Write-Host "    qcp connect" -ForegroundColor DarkGray
Write-Host "    qcp schema scan" -ForegroundColor DarkGray
Write-Host "    qcp ask `"What were our top customers?`"" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Docs: https://github.com/Moduna-AI/qcp" -ForegroundColor Cyan
Write-Host ""
