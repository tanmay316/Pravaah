<#
.SYNOPSIS
  Build the Pravaah web app (Expo) and deploy it.

.EXAMPLE
  .\scripts\deploy_web.ps1                      # build + deploy to Firebase Hosting (REST API, service account)
  .\scripts\deploy_web.ps1 -Target firebase-cli # build + `firebase deploy --only hosting`
  .\scripts\deploy_web.ps1 -Target netlify      # build + Netlify production deploy
  .\scripts\deploy_web.ps1 -Target vercel       # build + Vercel production deploy
  .\scripts\deploy_web.ps1 -Target docker       # nginx image "pravaah-web" built from source (run anywhere)
  .\scripts\deploy_web.ps1 -Target build        # only build apps/expo/dist (copy it to any static server)
#>
param(
    [ValidateSet("firebase", "firebase-cli", "netlify", "vercel", "docker", "build")]
    [string]$Target = "firebase",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$App = Join-Path $Root "apps\expo"
$Dist = Join-Path $App "dist"

function Invoke-Checked([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Exe $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

if (-not $SkipBuild -and $Target -ne "docker") {
    if (-not (Test-Path (Join-Path $App ".env"))) {
        Write-Warning "apps/expo/.env not found: EXPO_PUBLIC_* values must come from the environment."
    }
    if (-not (Test-Path (Join-Path $App "node_modules"))) {
        Push-Location $App
        try { Invoke-Checked "npm.cmd" @("install") } finally { Pop-Location }
    }
    Write-Host "[build] expo export --platform web" -ForegroundColor Cyan
    Invoke-Checked (Join-Path $App "node_modules\.bin\expo.cmd") @("export", $App, "--platform", "web", "--clear")
}
if ($Target -ne "docker" -and -not (Test-Path (Join-Path $Dist "index.html"))) { throw "Build output missing: $Dist\index.html" }

switch ($Target) {
    "firebase" {
        $Python = Join-Path $Root ".venv\Scripts\python.exe"
        if (-not (Test-Path $Python)) { $Python = "python" }
        Invoke-Checked $Python @((Join-Path $Root "scripts\deploy_web_hosting.py"))
    }
    "firebase-cli" {
        Push-Location $Root
        try { Invoke-Checked "npx.cmd" @("--yes", "firebase-tools", "deploy", "--only", "hosting") } finally { Pop-Location }
    }
    "netlify" {
        Push-Location $Root
        try { Invoke-Checked "npx.cmd" @("--yes", "netlify-cli", "deploy", "--prod", "--dir", $Dist) } finally { Pop-Location }
    }
    "vercel" {
        # Uploads the prebuilt dist with deploy/web/vercel.json (SPA rewrite + cache headers).
        Copy-Item (Join-Path $Root "deploy\web\vercel.json") (Join-Path $Dist "vercel.json") -Force
        Push-Location $Dist
        try { Invoke-Checked "npx.cmd" @("--yes", "vercel", "deploy", "--prod") } finally { Pop-Location }
    }
    "docker" {
        # The image builds the web app itself; EXPO_PUBLIC_* values are baked in at build time.
        $BuildArgs = @("build", "-f", "deploy/web/Dockerfile", "-t", "pravaah-web")
        $EnvFile = Join-Path $App ".env"
        if (Test-Path $EnvFile) {
            Get-Content $EnvFile | Where-Object { $_ -match '^\s*EXPO_PUBLIC_\w+\s*=' } | ForEach-Object {
                $BuildArgs += @("--build-arg", $_.Trim())
            }
        }
        Push-Location $Root
        try { Invoke-Checked "docker" ($BuildArgs + ".") } finally { Pop-Location }
        Write-Host "Run it with: docker run -d -p 8080:8080 --name pravaah-web pravaah-web" -ForegroundColor Green
    }
    "build" {
        Write-Host "Static site ready in $Dist. Serve it with SPA fallback to /index.html (see deploy/web/)." -ForegroundColor Green
    }
}
