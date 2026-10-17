# PowerShell Runner para QA E2E en Staging con Playwright
param(
    [string]$BypassSecret = $env:VERCEL_AUTOMATION_BYPASS_SECRET
)

$ErrorActionPreference = "Stop"

if (-not $BypassSecret -or $BypassSecret.Trim() -eq "") {
    Write-Host ""
    Write-Host "❌ ERROR: No se detectó la variable VERCEL_AUTOMATION_BYPASS_SECRET." -ForegroundColor Red
    Write-Host "Por favor configúrela en su sesión de PowerShell antes de ejecutar:" -ForegroundColor Yellow
    Write-Host '   $env:VERCEL_AUTOMATION_BYPASS_SECRET = "<su-secreto-de-bypass>"' -ForegroundColor Cyan
    Write-Host "   .\scripts\run-e2e-staging.ps1" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "O pásela como parámetro del script:" -ForegroundColor Yellow
    Write-Host "   .\scripts\run-e2e-staging.ps1 -BypassSecret <su-secreto-de-bypass>" -ForegroundColor Cyan
    Write-Host ""
    exit 1
}

$env:VERCEL_AUTOMATION_BYPASS_SECRET = $BypassSecret

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "Iniciando QA E2E Real en Staging (Playwright + Chromium)" -ForegroundColor Cyan
Write-Host "Target: https://staging.puntoencuentro.com.ar" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

npx --workspaces=false tsx scripts/e2e-staging-playwright.ts
