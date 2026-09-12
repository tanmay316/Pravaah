# Pravaah — 100% Free-Tier Multi-Cloud Deployment Guide

Deploy Pravaah completely on permanent free tiers, with zero monthly cloud cost, sub-600ms latency, and direct Android `.apk` builds for end users.

---

## Architecture of the Free-Tier Stack

| Component | Free Cloud Provider | Included Free Quota | Monthly Cost |
| :--- | :--- | :--- | :--- |
| **Compute / Backend Host** | **Oracle Cloud Always Free** | 4 OCPU Ampere A1 (ARM64), 24 GB RAM, 200 GB SSD, 10 TB egress | **$0.00** |
| **Realtime WebRTC Audio** | **LiveKit Cloud** | 50 GB monthly bandwidth (~1,000 participant voice minutes) | **$0.00** |
| **Ultra-Fast STT & LLM** | **Groq Cloud** | Free tier API access for `whisper-large-v3-turbo` & `qwen/qwen3.8-27b` | **$0.00** |
| **Linguistic Analysis** | **Google AI Studio** | Generous free tier for `gemini-2.5-flash-lite` | **$0.00** |
| **Database & Auth** | **Firebase Spark Plan** | 50,000 reads/day, 20,000 writes/day, 1 GB storage | **$0.00** |
| **Android APK Builder** | **Expo Application Services (EAS)** | Free tier monthly cloud build credits | **$0.00** |

---

## Part 1: Provisioning Oracle Cloud Always-Free Compute

### 1. Create the Instance
1. Sign up for an [Oracle Cloud Free Tier account](https://www.oracle.com/cloud/free/).
2. In the Oracle Cloud Console, navigate to **Compute > Instances > Create Instance**.
3. Configure the VM:
   - **Image**: `Ubuntu 24.04 LTS (aarch64)`
   - **Shape**: `Ampere (VM.Standard.A1.Flex)`
   - **OCPUs**: `4` (Always Free maximum)
   - **Memory**: `24 GB` (Always Free maximum)
   - **Boot Volume**: `100 GB` to `200 GB`
4. Download your private SSH key and click **Create**.

### 2. Configure VCN Firewall / Ingress Rules
1. In the console, go to **Networking > Virtual Cloud Networks > Default Security List**.
2. Add Ingress Rules:
   - `Port 80` (HTTP)
   - `Port 443` (HTTPS)
   - `Port 8000` (FastAPI backend)
   - `Port 8880` (Neural TTS server)

---

## Part 2: Deploying Pravaah on the VM

### 1. Connect and Install Docker
SSH into your Oracle Cloud instance:
```bash
ssh -i your-ssh-key.key ubuntu@<YOUR_ORACLE_PUBLIC_IP>
```

Install Docker and Git:
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl docker.io docker-compose
sudo usermod -aG docker $USER
newgrp docker
```

### 2. Clone the Codebase
```bash
git clone https://github.com/tanmay316/Pravaah.git
cd Pravaah
```

### 3. Configure Environment Variables
Create `.env` in the root directory:
```bash
cat << 'EOF' > .env
# LiveKit Cloud (free tier from cloud.livekit.io)
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_livekit_api_key
LIVEKIT_API_SECRET=your_livekit_api_secret

# AI Providers (free keys from console.groq.com & aistudio.google.com)
GROQ_API_KEY=gsk_your_groq_api_key
GEMINI_API_KEY=your_gemini_api_key

# Fast STT Engine (Groq Whisper Turbo: ~90ms latency)
STT_PROVIDER=groq_turbo

# Firebase Configuration
FIREBASE_SERVICE_ACCOUNT_JSON=/app/secrets/firebase-service-account.json
EOF
```

Copy your Firebase service account JSON key:
```bash
mkdir -p secrets
nano secrets/firebase-service-account.json
# Paste your Firebase service account credentials here
```

### 4. Launch All Services
```bash
docker-compose -f docker-compose.free-tier.yml up -d --build
```

Verify services are healthy:
```bash
docker-compose -f docker-compose.free-tier.yml ps
curl http://localhost:8000/docs
curl http://localhost:8880/health
```

---

## Part 3: Building and Publishing the Android APK

The mobile application is optimized so that **all heavy neural processing runs on the server**. Your Android device will not heat up, drain battery, or experience mobile audio lag.

### 1. Build Downloadable Standalone `.apk` with EAS (Recommended)
From your local machine in `apps/expo`:
```bash
cd apps/expo

# 1. Install EAS CLI if not already installed
npm install -g eas-cli

# 2. Log in with your free Expo account (or create one at expo.dev)
eas login

# 3. Trigger 1-click APK build
npm run build:apk
# Or run: eas build -p android --profile preview
```

When the build completes, EAS provides a direct download link and QR code to download and install the `pravaah.apk` file directly onto any Android phone.

### 2. Local APK Build with Android SDK (Alternative)
If you have Android Studio / Android SDK installed locally:
```bash
cd apps/expo
npx expo run:android --variant release
```
The compiled `.apk` will be output to:
`apps/expo/android/app/build/outputs/apk/release/app-release.apk`

---

## Part 4: Outdoor & Running Noise Optimization

When learners use Pravaah outdoors while walking or running:
1. **Low-Frequency Wind Buffering**:
   - WebRTC captures mono audio with hardware highpass filtering enabled.
   - Low-frequency vehicle rumbles (<80Hz) and wind buffeting are attenuated before hitting the network.
2. **Silero VAD Sensitivity**:
   - `activation_threshold` is tuned to `0.60`.
   - Wind gusts, footstep thuds, and heavy breathing are filtered out while human speech formants are captured.
3. **Interruption Protection**:
   - `min_interruption_duration = 0.35s` prevents a sudden footstep sound or outdoor cough from interrupting the AI tutor's voice.
4. **Bilingual Speech**:
   - `whisper-large-v3-turbo` seamlessly recognizes English, Hindi (Devanagari), and conversational Hinglish.
