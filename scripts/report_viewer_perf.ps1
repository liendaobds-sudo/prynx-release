param(
    [string]$LogPath = (Join-Path $env:USERPROFILE 'Desktop\PrynX_RenderPerf.log'),
    [int]$Tail = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $LogPath)) {
    throw "Không tìm thấy log Viewer: $LogPath"
}

$lines = if ($Tail -gt 0) {
    @(Get-Content -LiteralPath $LogPath -Tail $Tail)
} else {
    @(Get-Content -LiteralPath $LogPath)
}

$bootstrapMs = @()
$firstPixelMs = @()
$attempts = @{}
$inputToCommitMs = @()
$decodeMsList = @()
$sharpCommits = 0
$targetSharpCommits = 0
$ppeTotalMs = @()
$ppeSemWaitMs = @()
$ppeWorkerQueueMs = @()
$cacheImageHits = @()
$cacheImageMisses = @()
$cacheFormHits = @()
$cacheFormMisses = @()
$affinity = @{ assign = 0; hit = 0; drop = 0 }
$governor = @{ ppeMemoryBudget = 0; gpuMemory = 0; tileCachePressure = 0; poolAdmission = 0; surfaceErrors = 0 }
$latestPpeMemory = $null
$latestGpuMemory = $null
$latestPoolAdmission = $null
$counts = @{
    pdfLoadStart = 0
    tileSlow = 0
    stale = 0
    cancelled = 0
    priorityPromote = 0
}

function Get-Stats([object[]]$Values) {
    $numbers = @($Values | ForEach-Object { [double]$_ } | Sort-Object)
    if ($numbers.Count -eq 0) { return $null }
    $p50Index = [Math]::Min($numbers.Count - 1, [Math]::Floor(($numbers.Count - 1) * 0.50))
    $p95Index = [Math]::Min($numbers.Count - 1, [Math]::Floor(($numbers.Count - 1) * 0.95))
    return [ordered]@{
        count = $numbers.Count
        min = $numbers[0]
        p50 = $numbers[$p50Index]
        p95 = $numbers[$p95Index]
        max = $numbers[$numbers.Count - 1]
    }
}

foreach ($line in $lines) {
    if ($line -match '(?:FE )?VIEWER_TRACE (\{.*\})') {
        try {
            $event = $matches[1] | ConvertFrom-Json
            switch ([string]$event.event) {
                'pdf-load-start' { $counts.pdfLoadStart++ }
                'pdf-bootstrap-ready' {
                    if ($null -ne $event.bootstrap_ms) { $bootstrapMs += [double]$event.bootstrap_ms }
                }
                'tile-first-pixel' {
                    if ($null -ne $event.native_to_decode_ms) { $firstPixelMs += [double]$event.native_to_decode_ms }
                }
                'tile-slow' { $counts.tileSlow++ }
                'tile-priority-promote' { $counts.priorityPromote++ }
                'tile-sharpness-commit' {
                    $sharpCommits++
                    if ($null -ne $event.decode_ms) { $decodeMsList += [double]$event.decode_ms }
                    if ($event.is_target_sharp) { $targetSharpCommits++ }
                    if ($null -ne $event.input_to_commit_ms) { $inputToCommitMs += [double]$event.input_to_commit_ms }

                    $attemptId = [string]$event.sharpness_attempt_id
                    if (-not [string]::IsNullOrEmpty($attemptId)) {
                        if (-not $attempts.ContainsKey($attemptId)) {
                            $attempts[$attemptId] = [ordered]@{
                                first_readable_ms = $null
                                target_sharp_ms = $null
                                is_target_sharp = $false
                            }
                        }
                        $entry = $attempts[$attemptId]
                        $latency = if ($null -ne $event.input_to_commit_ms) { [double]$event.input_to_commit_ms } else { $null }
                        if ($null -ne $latency -and ($null -eq $entry.first_readable_ms -or $latency -lt $entry.first_readable_ms)) {
                            $entry.first_readable_ms = $latency
                        }
                        if ($event.is_target_sharp -eq $true -and $null -ne $latency) {
                            $entry.is_target_sharp = $true
                            if ($null -eq $entry.target_sharp_ms -or $latency -lt $entry.target_sharp_ms) {
                                $entry.target_sharp_ms = $latency
                            }
                        }
                    }
                }
            }
        } catch {
            # Log nhiều worker có thể bị xen byte; bỏ qua JSON hỏng, giữ các phase khác.
        }
    }

    if ($line -match 'render-coordinator-result .*"status":"stale"') { $counts.stale++ }
    if ($line -match 'render-coordinator-result .*"status":"cancelled"') { $counts.cancelled++ }
    if ($line -match 'PPE_NATIVE_RESULT .*total_ms=(\d+) sem_wait_ms=(\d+) worker_queue_ms=(\d+)') {
        $ppeTotalMs += [double]$matches[1]
        $ppeSemWaitMs += [double]$matches[2]
        $ppeWorkerQueueMs += [double]$matches[3]
    }
    if ($line -match 'PPE_SESSION_CACHE .*image_hits=(\d+) image_misses=(\d+) form_hits=(\d+) form_misses=(\d+)') {
        $cacheImageHits += [double]$matches[1]
        $cacheImageMisses += [double]$matches[2]
        $cacheFormHits += [double]$matches[3]
        $cacheFormMisses += [double]$matches[4]
    }
    if ($line -match 'RENDER_WORKER_AFFINITY action=(assign|hit|drop)') {
        $affinity[$matches[1]]++
    }
    if ($line -match 'PPE_MEMORY_BUDGET total_bytes=(\d+) available_bytes=(\d+) working_set_bytes=(\d+) lanes=(\d+) emergency=(\w+) render_bytes=(\d+) cache_bytes=(\d+)') {
        $governor.ppeMemoryBudget++
        $latestPpeMemory = [ordered]@{ total_bytes = [double]$matches[1]; available_bytes = [double]$matches[2]; working_set_bytes = [double]$matches[3]; lanes = [int]$matches[4]; emergency = [bool]::Parse($matches[5]); render_bytes = [double]$matches[6]; cache_bytes = [double]$matches[7] }
    }
    if ($line -match 'GPU_MEMORY total_bytes=(\d+) available_bytes=(\d+) budget_bytes=(\d+) current_bytes=(\d+) system_pressure=(\w+) gpu_pressure=(\w+)') {
        $governor.gpuMemory++
        $latestGpuMemory = [ordered]@{ total_bytes = [double]$matches[1]; available_bytes = [double]$matches[2]; budget_bytes = [double]$matches[3]; current_bytes = [double]$matches[4]; system_pressure = [bool]::Parse($matches[5]); gpu_pressure = [bool]::Parse($matches[6]) }
    }
    if ($line -match 'TILE_CACHE_PRESSURE ') { $governor.tileCachePressure++ }
    if ($line -match 'POOL_ADMISSION ') {
        $governor.poolAdmission++
        $latestPoolAdmission = $line
    }
    if ($line -match 'GPU_SURFACE_ERROR ') { $governor.surfaceErrors++ }
}

$imageHitTotal = ($cacheImageHits | Measure-Object -Sum).Sum
$imageMissTotal = ($cacheImageMisses | Measure-Object -Sum).Sum
$formHitTotal = ($cacheFormHits | Measure-Object -Sum).Sum
$formMissTotal = ($cacheFormMisses | Measure-Object -Sum).Sum
$imageDenominator = $imageHitTotal + $imageMissTotal
$formDenominator = $formHitTotal + $formMissTotal

$firstReadableList = @()
$targetSharpList = @()
$successfulAttempts = 0
$incompleteAttempts = 0

foreach ($kv in $attempts.GetEnumerator()) {
    $att = $kv.Value
    if ($null -ne $att.first_readable_ms) {
        $firstReadableList += $att.first_readable_ms
    }
    if ($att.is_target_sharp -and $null -ne $att.target_sharp_ms) {
        $targetSharpList += $att.target_sharp_ms
        $successfulAttempts++
    } else {
        $incompleteAttempts++
    }
}

[ordered]@{
    log = (Resolve-Path -LiteralPath $LogPath).Path
    lines = $lines.Count
    counts = $counts
    bootstrap_ms = Get-Stats $bootstrapMs
    first_pixel_native_to_decode_ms = Get-Stats $firstPixelMs
    ppe_total_ms = Get-Stats $ppeTotalMs
    ppe_sem_wait_ms = Get-Stats $ppeSemWaitMs
    ppe_worker_queue_ms = Get-Stats $ppeWorkerQueueMs
    time_to_sharp = [ordered]@{
        total_attempts = ($successfulAttempts + $incompleteAttempts)
        successful_sharp_attempts = $successfulAttempts
        incomplete_attempts = $incompleteAttempts
        first_readable_ms = Get-Stats $firstReadableList
        target_sharp_ms = Get-Stats $targetSharpList
        decode_ms = Get-Stats $decodeMsList
        raw_commits = [ordered]@{
            total = $sharpCommits
            target_sharp = $targetSharpCommits
            latency_ms = Get-Stats $inputToCommitMs
        }
    }
    cache = [ordered]@{
        image_hits = $imageHitTotal
        image_misses = $imageMissTotal
        image_hit_ratio = if ($imageDenominator -gt 0) { [Math]::Round($imageHitTotal / $imageDenominator, 4) } else { $null }
        form_hits = $formHitTotal
        form_misses = $formMissTotal
        form_hit_ratio = if ($formDenominator -gt 0) { [Math]::Round($formHitTotal / $formDenominator, 4) } else { $null }
    }
    affinity = $affinity
    governor = $governor
    latest_ppe_memory = $latestPpeMemory
    latest_gpu_memory = $latestGpuMemory
    latest_pool_admission = $latestPoolAdmission
} | ConvertTo-Json -Depth 6
