@echo off
title Pravaah Platform Launcher
echo ===================================================
echo           Starting Pravaah AI Platform             
echo ===================================================
echo.

echo [1/4] Starting Kokoro Local Neural TTS Server (Port 8880)...
start "Pravaah Kokoro TTS (Port 8880)" cmd /k "cd /d %~dp0services\voice-agent && python kokoro_server.py"

echo [2/4] Starting FastAPI Backend on Port 8000...
start "Pravaah API (Port 8000)" cmd /k "cd /d %~dp0services\api && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"

echo [3/4] Starting LiveKit Cloud Voice Agent Worker...
start "Pravaah Voice Agent" cmd /k "cd /d %~dp0services\voice-agent && python agent.py dev"

echo [4/4] Starting Expo Web Frontend on Port 8081...
start "Pravaah Web Frontend" cmd /k "cd /d %~dp0apps\expo && npx expo start --web"

echo.
echo ===================================================
echo All Pravaah services launched successfully!
echo Web App: http://localhost:8081
echo API Docs: http://localhost:8000/docs
echo TTS Server: http://127.0.0.1:8880/health
echo ===================================================
echo.
pause
