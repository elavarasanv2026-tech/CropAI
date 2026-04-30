# IoT Crop Recommendation Server Startup
Write-Host "============================" -ForegroundColor Green
Write-Host "Starting Crop AI Server..." -ForegroundColor Yellow
Write-Host "============================" -ForegroundColor Green

# Kill existing node processes properly
Write-Host "Cleaning up old processes..."
Stop-Process -Name "node" -ErrorAction SilentlyContinue | Out-Null

Write-Host "Launching backend/server.js..."
node backend/server.js
