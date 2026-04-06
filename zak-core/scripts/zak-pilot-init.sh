#!/bin/bash
# ZAK Pilot Initialization Script
# Enforce Deterministic Locale
export LC_ALL=C
export LANG=C

echo "=== ZAK PILOT INITIALIZATION ==="
echo "[INIT] Locale locked to POSIX (C). String sorting is now binary."

# 1. Hardware Check
echo "[1/3] Checking Hardware..."
if command -v nvidia-smi &> /dev/null; then
    echo "  - GPU: Detected (NVIDIA)"
    nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
else
    echo "  - GPU: Not found, using CPU mode"
fi
echo "  - RAM: $(free -h | awk '/^Mem:/ {print $2}')"

# 2. Air-Gap Verification
echo "[2/3] Verifying Air-Gap..."
if ping -c 1 8.8.8.8 &> /dev/null; then
    echo "  - WARNING: External network detected. Ensure air-gap for production."
else
    echo "  - NETWORK: Air-gap confirmed."
fi

# 3. Dependency Check
echo "[3/3] Checking Dependencies..."
if ! command -v node &> /dev/null; then
    echo "  - ERROR: Node.js not found."
    exit 1
fi
echo "  - Node: $(node -v)"
echo "  - Project: zak-core v1.0.0"

echo "=== INIT COMPLETE ==="

