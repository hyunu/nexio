param(
  [switch]$Portable
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

Write-Host "=== Nexio Client Windows Build ===" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
$nodeVer = node -v 2>$null
if (-not $nodeVer) {
  Write-Host "Node.js is required. Download from https://nodejs.org" -ForegroundColor Red
  exit 1
}
Write-Host "Node.js: $nodeVer"

# Install dependencies
Write-Host "`nInstalling dependencies..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) {
  Write-Host "npm install failed" -ForegroundColor Red
  exit 1
}

# Build Vite + Electron TypeScript
Write-Host "`nBuilding..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
  Write-Host "Build failed" -ForegroundColor Red
  exit 1
}

# Package
Write-Host "`nPackaging for Windows..." -ForegroundColor Yellow
if ($Portable) {
  npx electron-builder --win portable
} else {
  npx electron-builder --win
}
if ($LASTEXITCODE -ne 0) {
  Write-Host "Packaging failed" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host "Output: $root\release\"