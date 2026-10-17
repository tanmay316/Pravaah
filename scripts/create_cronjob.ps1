# Creates (or updates) the cron-job.org job that pings the Render backend every 10 minutes.
# Usage:  .\scripts\create_cronjob.ps1        (prompts for your cron-job.org API key)
# API key: https://console.cron-job.org -> Settings -> API -> Create API key

param(
    [string]$Url = "https://pravaah-backend-ntlz.onrender.com/health"
)

$key = $env:CRONJOB_API_KEY
if (-not $key) {
    $secure = Read-Host "cron-job.org API key" -AsSecureString
    $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

$headers = @{ Authorization = "Bearer $key"; "Content-Type" = "application/json" }
$api = "https://api.cron-job.org"

$job = @{
    job = @{
        url            = $Url
        title          = "Pravaah - keep Render awake"
        enabled        = $true
        saveResponses  = $false
        # Free plan caps timeouts at 30s; a cold start may exceed it but the request still wakes Render.
        requestTimeout = 30
        requestMethod  = 0
        schedule       = @{
            timezone  = "Asia/Kolkata"
            expiresAt = 0
            hours     = @(-1)
            mdays     = @(-1)
            months    = @(-1)
            wdays     = @(-1)
            minutes   = @(0, 10, 20, 30, 40, 50)
        }
        notification   = @{ onFailure = $true; onFailureCount = 3; onSuccess = $true; onDisable = $true }
    }
} | ConvertTo-Json -Depth 6

$existing = (Invoke-RestMethod -Method Get -Uri "$api/jobs" -Headers $headers).jobs |
    Where-Object { $_.url -eq $Url } | Select-Object -First 1

if ($existing) {
    Invoke-RestMethod -Method Patch -Uri "$api/jobs/$($existing.jobId)" -Headers $headers -Body $job | Out-Null
    Write-Host "Updated existing cron job $($existing.jobId) -> $Url every 10 minutes"
} else {
    $created = Invoke-RestMethod -Method Put -Uri "$api/jobs" -Headers $headers -Body $job
    Write-Host "Created cron job $($created.jobId) -> $Url every 10 minutes"
}
Write-Host "View it at https://console.cron-job.org/jobs"
