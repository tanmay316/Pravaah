#!/usr/bin/env bash
# ==============================================================================
# Pravaah — Deploy Backend to Google Cloud Run (Free Tier)
#
# Free Tier Specs:
#   - Region: us-central1 (eligible for GCP Free Tier: 2M requests/mo, 360k GB-sec)
#   - Memory: 1Gi (Double Render's 512MB limit)
#   - Scaling: min-instances 0 (scales to zero when idle = 0 cost)
#   - Port: 8080 (Cloud Run default)
# ==============================================================================

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-pravaah-backend}"
REGION="${REGION:-us-central1}"
MEMORY="${MEMORY:-1Gi}"
CPU="${CPU:-1}"

echo "=================================================="
echo "  Deploying Pravaah Backend to Google Cloud Run   "
echo "  Service: ${SERVICE_NAME}                        "
echo "  Region:  ${REGION}                              "
echo "  Memory:  ${MEMORY}                              "
echo "=================================================="

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "Error: gcloud CLI is not installed or not in PATH."
    echo "You can run this directly inside Google Cloud Shell in your browser:"
    echo "  https://shell.cloud.google.com"
    exit 1
fi

PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
    echo "No GCP project is currently set. Listing available projects:"
    gcloud projects list
    read -rp "Enter your GCP Project ID: " PROJECT_ID
    gcloud config set project "$PROJECT_ID"
fi

echo "Using GCP Project: ${PROJECT_ID}"

# Enable necessary Google Cloud APIs
echo "Ensuring required Cloud APIs are enabled..."
gcloud services enable \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    artifactregistry.googleapis.com

echo "Building and deploying container from source to Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
    --source . \
    --platform managed \
    --region "${REGION}" \
    --allow-unauthenticated \
    --memory "${MEMORY}" \
    --cpu "${CPU}" \
    --min-instances 0 \
    --max-instances 10 \
    --set-env-vars RUN_VOICE_AGENT=false,TTS_VOICE_DEFAULT=warm_male

SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" --platform managed --region "${REGION}" --format 'value(status.url)')

echo "=================================================="
echo "  Deployment Successful!                          "
echo "  Backend URL: ${SERVICE_URL}                     "
echo "=================================================="
echo ""
echo "Next step: Set your API secrets in Cloud Run via console or gcloud:"
echo "  gcloud run services update ${SERVICE_NAME} --region ${REGION} \\"
echo "    --update-env-vars LIVEKIT_URL=...,LIVEKIT_API_KEY=...,LIVEKIT_API_SECRET=...,GROQ_API_KEY=...,GEMINI_API_KEY=..."
echo ""
echo "And update apps/expo/.env with:"
echo "  EXPO_PUBLIC_API_URL=${SERVICE_URL}"
