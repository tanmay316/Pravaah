# ==============================================================================
# Pravaah — Deploy Backend to Google Cloud Run (PowerShell)
# ==============================================================================

param (
    [string]$ServiceName = "pravaah-backend",
    [string]$Region = "us-central1",
    [string]$Memory = "1Gi",
    [string]$Cpu = "1"
)

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  Deploying Pravaah Backend to Google Cloud Run   " -ForegroundColor Cyan
Write-Host "  Service: $ServiceName                           " -ForegroundColor Cyan
Write-Host "  Region:  $Region                                " -ForegroundColor Cyan
Write-Host "  Memory:  $Memory                                " -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    Write-Host "Error: gcloud CLI is not installed on this system." -ForegroundColor Red
    Write-Host "Option 1: Run this directly in Google Cloud Shell (browser): https://shell.cloud.google.com" -ForegroundColor Yellow
    Write-Host "Option 2: Install Google Cloud SDK: https://cloud.google.com/sdk/docs/install" -ForegroundColor Yellow
    exit 1
}

$projectId = (gcloud config get-value project 2>$null).Trim()
if ([string]::IsNullOrWhiteSpace($projectId) -or $projectId -eq "(unset)") {
    Write-Host "Listing your GCP projects..." -ForegroundColor Yellow
    gcloud projects list
    $projectId = Read-Host "Enter your GCP Project ID"
    gcloud config set project $projectId
}

Write-Host "Using GCP Project: $projectId" -ForegroundColor Green

Write-Host "Ensuring Cloud Run & Cloud Build APIs are enabled..." -ForegroundColor Yellow
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

Write-Host "Deploying container to Cloud Run..." -ForegroundColor Yellow
gcloud run deploy $ServiceName `
    --source . `
    --platform managed `
    --region $Region `
    --allow-unauthenticated `
    --memory $Memory `
    --cpu $Cpu `
    --min-instances 0 `
    --max-instances 10 `
    --set-env-vars RUN_VOICE_AGENT=false,TTS_VOICE=en-IN-PrabhatNeural,GROQ_TTS_VOICE=troy

$serviceUrl = (gcloud run services describe $ServiceName --platform managed --region $Region --format 'value(status.url)').Trim()

Write-Host "==================================================" -ForegroundColor Green
Write-Host "  Deployment Successful!" -ForegroundColor Green
Write-Host "  Backend URL: $serviceUrl" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Update apps/expo/.env with:" -ForegroundColor Cyan
Write-Host "  EXPO_PUBLIC_API_URL=$serviceUrl" -ForegroundColor White
