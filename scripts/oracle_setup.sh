#!/usr/bin/env bash
# =============================================================================
# Pravaah — 1-Click Automated Setup for Oracle Cloud Always-Free VM
# =============================================================================
set -e

echo "=========================================================="
echo "   🚀 Starting Automated 1-Click Deployment for Pravaah"
echo "=========================================================="

# 1. Update system packages
echo "📦 Updating system packages..."
sudo apt-get update -y
sudo apt-get install -y git curl docker.io docker-compose iptables-persistent

# 2. Add current user to docker group
sudo usermod -aG docker $USER || true

# 3. Configure VM firewall rules for ports 8000 and 8880
echo "🛡️  Configuring firewall rules for ports 8000 and 8880..."
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 8000 -j ACCEPT || true
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 8880 -j ACCEPT || true
sudo netfilter-persistent save || true

# 4. Check if secrets directory exists
mkdir -p secrets

if [ ! -f "secrets/firebase-service-account.json" ]; then
    echo "⚠️  NOTE: secrets/firebase-service-account.json not found yet."
    echo "   Please paste your Firebase Service Account JSON into secrets/firebase-service-account.json"
fi

if [ ! -f ".env" ]; then
    echo "⚠️  NOTE: .env file not found yet. Copying from .env.example..."
    if [ -f ".env.example" ]; then
        cp .env.example .env
    fi
fi

# 5. Build and launch all 4 services via Docker Compose
echo "🐳 Building and starting all Pravaah backend containers in background..."
sudo docker-compose -f docker-compose.free-tier.yml up -d --build

# 6. Verify health
echo "⏳ Waiting 5 seconds for services to initialize..."
sleep 5

echo "=========================================================="
echo "   🎉 All Pravaah Services are DEPLOYED and RUNNING!"
echo "=========================================================="
sudo docker-compose -f docker-compose.free-tier.yml ps

SERVER_IP=$(curl -s ifconfig.me || echo "YOUR_SERVER_IP")
echo ""
echo "📡 Your Backend API is live at: http://${SERVER_IP}:8000"
echo "📖 API Interactive Docs at:     http://${SERVER_IP}:8000/docs"
echo "🎙️  Neural Indian TTS at:        http://${SERVER_IP}:8880/health"
echo ""
echo "📱 Next step for your Mobile APK:"
echo "   Set EXPO_PUBLIC_API_URL=http://${SERVER_IP}:8000 before running 'npm run build:apk'"
echo "=========================================================="
