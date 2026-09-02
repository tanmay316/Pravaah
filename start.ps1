Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "          Starting Pravaah AI Platform             " -ForegroundColor Green
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""

$root = $PSScriptRoot
if (-not $root) { $root = Get-Location }

Write-Host "[1/4] Starting Kokoro Local Neural TTS Server (Port 8880)..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\services\voice-agent'; python kokoro_server.py"

Write-Host "[2/4] Starting FastAPI Backend on Port 8000..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\services\api'; python -m uvicorn app.main:app --port 8000 --reload"

Write-Host "[3/4] Starting LiveKit Cloud Voice Agent Worker..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\services\voice-agent'; python agent.py dev"

Write-Host "[4/4] Starting Expo Web Frontend on Port 8081..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\apps\expo'; npx expo start --web"

Write-Host ""
Write-Host "===================================================" -ForegroundColor Green
Write-Host "All Pravaah services launched successfully!" -ForegroundColor Green
Write-Host "Web App: http://localhost:8081" -ForegroundColor Cyan
Write-Host "API Docs: http://localhost:8000/docs" -ForegroundColor Cyan
Write-Host "TTS Server: http://127.0.0.1:8880/health" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Green
