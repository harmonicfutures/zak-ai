@echo off
echo === ZEM: STARTING ENTERPRISE MANAGER (WINDOWS) ===

echo [1/3] Setting up Backend...
cd zak-zem\backend
call npm install --no-audit --no-fund

echo [2/3] Setting up Frontend...
cd ..\frontend
call npm install --no-audit --no-fund

echo [3/3] Launching ZEM Services...
start /b cmd /c "cd ..\backend && npm run dev"
start cmd /c "cd ..\frontend && npm run dev"

echo ZEM Services are launching. 
echo Backend: http://localhost:3001
echo Frontend: http://localhost:5173
pause

