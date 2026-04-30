@echo off
REM IoT Crop Recommendation Server Starter
REM This batch file starts the Node.js server properly

title IoT Crop Recommendation Server
cls
cd /d "%~dp0"

echo ===============================================
echo IoT Crop Recommendation Server
echo ===============================================
echo.
echo Starting server...
echo.

REM Check if node is installed
node --version > nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed or not in PATH
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo Node.js found: 
node --version

echo.
echo Installing dependencies (if needed)...
npm install --save > nul 2>&1

echo.
echo ===============================================
echo Server starting on http://localhost:3000
echo ===============================================
echo.
echo Press CTRL+C to stop the server
echo.

REM Start the server
node backend\server.js

pause
