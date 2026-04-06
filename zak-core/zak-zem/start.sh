#!/bin/bash
# ZEM Boot Script

echo "=== ZEM: STARTING ENTERPRISE MANAGER ==="

# 1. Install Backend Dependencies
echo "[1/3] Setting up Backend..."
cd backend && npm install > /dev/null 2>&1

# 2. Install Frontend Dependencies
echo "[2/3] Setting up Frontend..."
cd ../frontend && npm install > /dev/null 2>&1

# 3. Start Both Services
echo "[3/3] Launching ZEM Services..."
cd ../backend && npm run dev &
cd ../frontend && npm run dev

