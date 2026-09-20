# Deploying Pravaah Backend to Google Cloud Run (Free Tier)

This guide walks you through deploying the Pravaah backend to **Google Cloud Run** permanently on the **GCP Free Tier** (no Render 512MB RAM limits, no OOM crashes).

---

## 🎁 Free Tier Guarantee Checklist
Google Cloud Run's Always Free tier covers:
* **2 Million requests per month** (100% free)
* **360,000 GB-seconds memory** per month
* **180,000 vCPU-seconds** per month
* **1 GB outbound network transfer** per month from North America

By setting:
* **Region**: `us-central1` (Iowa) — Tier 1 Free Tier region
* **Memory**: `1 GiB` (2x Render's limit!)
* **Minimum instances**: `0` (scales down to 0 when not in use = **$0 cost**)
* **Maximum instances**: `10`

---

## Method 1: Deploy in 2 Minutes using Google Cloud Shell (Fastest & Easiest)

Google Cloud Shell is a free web terminal inside your browser with `gcloud` and `docker` pre-installed and authenticated.

1. Open [Google Cloud Shell](https://shell.cloud.google.com/) in your browser.
2. Clone your repository:
   ```bash
   git clone https://github.com/YOUR_GITHUB_USERNAME/Pravaah.git
   cd Pravaah
   ```
3. Run the automated deployment script:
   ```bash
   chmod +x ./scripts/deploy_cloud_run.sh
   ./scripts/deploy_cloud_run.sh
   ```
4. It will build your container and give you a live URL:
   ```text
   https://pravaah-backend-xxxxxx-uc.a.run.app
   ```

---

## Method 2: Deploy via Google Cloud Console Web UI (No Command Line)

1. Go to the [Google Cloud Run Console](https://console.cloud.google.com/run).
2. Click **Create Service**.
3. Select **"Continuously deploy from a repository"** and connect your GitHub account.
4. Select repository `Pravaah` and branch `main`.
5. Under **Build configuration**:
   * Build Type: **Dockerfile**
   * Source location: `/Dockerfile`
6. Under **Service configuration**:
   * **Service name**: `pravaah-backend`
   * **Region**: `us-central1` (Iowa)
   * **Authentication**: Check **"Allow unauthenticated invocations"**
7. Under **Container, Networking, Security**:
   * **Memory**: Select **`1 GiB`** (or `2 GiB`)
   * **CPU**: `1`
   * **Container port**: `10000` (or `8080`)
   * **Minimum number of instances**: `0`
   * **Maximum number of instances**: `10`
8. Under **Environment variables**, click **Add Variable**:
   * `RUN_VOICE_AGENT` = `false`
   * `LIVEKIT_URL` = `wss://pravaah-qj6q5gxo.livekit.cloud`
   * `LIVEKIT_API_KEY` = `<your_livekit_key>`
   * `LIVEKIT_API_SECRET` = `<your_livekit_secret>`
   * `GROQ_API_KEY` = `<your_groq_key>`
   * `GEMINI_API_KEY` = `<your_gemini_key>`
   * `TTS_VOICE` = `en-IN-PrabhatNeural`
   * `GROQ_TTS_VOICE` = `troy`
   * `FIREBASE_SERVICE_ACCOUNT_JSON` = `<paste your json string>`
9. Click **Create**!

---

## 3. Connect Frontend to the New Cloud Run Endpoint

Once deployed, copy your Cloud Run Service URL:
`https://pravaah-backend-xxxxxx-uc.a.run.app`

1. Update `apps/expo/.env`:
   ```bash
   EXPO_PUBLIC_API_URL=https://pravaah-backend-xxxxxx-uc.a.run.app
   ```
2. Re-export and deploy web frontend to Firebase Hosting:
   ```bash
   cd apps/expo
   npx expo export -p web
   cd ../..
   firebase deploy --only hosting
   ```
