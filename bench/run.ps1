param(
    [string]$OutDir = "E:\tmp\sa-steam-proxy-rust\bench",
    [int]$IdleSecs = 10,
    [int]$LoadSecs = 20,
    [int]$Concurrency = 32
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force $OutDir | Out-Null

$BenchDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NetName = "sa-steam-proxy-bench"

function Cleanup {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    docker rm -f bench-proxy-nest bench-proxy-rust bench-mock-steam bench-sampler bench-loadgen 2>$null | Out-Null
    docker network rm $NetName 2>$null | Out-Null
    $ErrorActionPreference = $prev
}

function Start-Proxy([string]$Impl, [string]$Image, [string]$MockIp) {
    $name = "bench-proxy-$Impl"
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    docker rm -f $name 2>$null | Out-Null
    $ErrorActionPreference = $prev

    # Pin api.steampowered.com in /etc/hosts to the mock container IP so DNS can never escape to real Steam.
    docker run -d --name $name --network $NetName --network-alias proxy `
        --add-host "api.steampowered.com:$MockIp" `
        -e LISTEN_HOST=0.0.0.0 -e LISTEN_PORT=8080 -e IMAGE_TAG=$Image `
        $Image | Out-Null

    # Wait for /ready 200
    for ($i = 0; $i -lt 30; $i++) {
        $prev = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        $code = docker run --rm --network $NetName node:22-alpine node -e "fetch('http://proxy:8080/ready').then(r=>console.log(r.status)).catch(()=>console.log(0))" 2>$null
        $ErrorActionPreference = $prev
        if ($code -eq "200") {
            return $name
        }
        Start-Sleep -Milliseconds 300
    }
    throw "Proxy $name failed to become ready"
}

function Run-Scenario([string]$Impl, [string]$Image, [string]$Scenario, [string]$MockIp) {
    Write-Host "`n=== [$Impl] scenario=$Scenario ==="
    $cname = Start-Proxy $Impl $Image $MockIp
    Start-Sleep -Seconds 2

    if ($Scenario -eq "idle") {
        $durMs = $IdleSecs * 1000
        $procJson = docker run --rm --pid="container:$cname" -v "${BenchDir}:/bench:ro" `
            -e INTERVAL_MS=500 -e DURATION_MS=$durMs `
            node:22-alpine node /bench/sample.mjs
        $proc = $procJson | ConvertFrom-Json
        $loadObj = [PSCustomObject]@{}
    } elseif ($Scenario -eq "parity") {
        $loadOut = docker run --rm --network $NetName -v "${BenchDir}:/bench:ro" `
            -e TARGET_HOST=proxy -e TARGET_PORT=8080 -e MODE=parity `
            node:22-alpine node /bench/loadgen.mjs
        $loadObj = ($loadOut -join "`n") | ConvertFrom-Json
        $procJson = docker run --rm --pid="container:$cname" -v "${BenchDir}:/bench:ro" `
            -e INTERVAL_MS=250 -e DURATION_MS=500 `
            node:22-alpine node /bench/sample.mjs
        $proc = $procJson | ConvertFrom-Json
    } else {
        # Start a single persistent sampler sidecar in the proxy's PID namespace (no per-second container spawns).
        $prev = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        docker rm -f bench-sampler 2>$null | Out-Null
        $ErrorActionPreference = $prev
        $samplerDurMs = ($LoadSecs + 5) * 1000
        docker run -d --name bench-sampler --pid="container:$cname" -v "${BenchDir}:/bench:ro" `
            -e INTERVAL_MS=500 -e DURATION_MS=$samplerDurMs `
            node:22-alpine node /bench/sample.mjs | Out-Null

        $loadOut = docker run --rm --network $NetName -v "${BenchDir}:/bench:ro" `
            -e TARGET_HOST=proxy -e TARGET_PORT=8080 -e MODE=$Scenario `
            -e CONCURRENCY=$Concurrency -e DURATION_SECS=$LoadSecs `
            node:22-alpine node /bench/loadgen.mjs
        $loadObj = ($loadOut | Select-Object -Last 1) | ConvertFrom-Json

        # Stop sampler gracefully so it prints its JSON summary, then read its logs.
        docker kill --signal=SIGTERM bench-sampler | Out-Null
        docker wait bench-sampler | Out-Null
        $procJson = (docker logs bench-sampler | Select-Object -Last 1)
        docker rm -f bench-sampler | Out-Null
        $proc = $procJson | ConvertFrom-Json
    }

    $record = [PSCustomObject]@{
        impl = $Impl
        scenario = $Scenario
        rssAvgMb = $proc.rssAvgMb
        rssPeakMb = $proc.rssPeakMb
        cpuPct = $proc.cpuPct
        threads = $proc.threads
        samples = $proc.samples
        load = $loadObj
    }

    $record | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 (Join-Path $OutDir "$Impl-$Scenario.json")
    Write-Host ("  RSS avg={0} MiB, peak={1} MiB, CPU={2}%, threads={3} ({4} samples)" -f $record.rssAvgMb, $record.rssPeakMb, $record.cpuPct, $record.threads, $record.samples)
    if ($Scenario -eq "cache-hit" -or $Scenario -eq "cache-miss") {
        Write-Host ("  Load: {0} req/s | p50={1}ms p95={2}ms p99={3}ms max={4}ms | ok={5} errs={6} sampleErr={7}" -f $record.load.rps, $record.load.p50Ms, $record.load.p95Ms, $record.load.p99Ms, $record.load.maxMs, $record.load.okCount, $record.load.errCount, $record.load.sampleError)
    } elseif ($Scenario -eq "parity") {
        Write-Host ("  Parity: passed={0}, failed={1}" -f $record.load.passed, $record.load.failed)
    }

    docker rm -f $cname | Out-Null
    return $record
}

try {
    Cleanup
    docker network create $NetName | Out-Null
    docker run -d --name bench-mock-steam --network $NetName --network-alias api.steampowered.com `
        -v "${BenchDir}:/bench:ro" node:22-alpine node /bench/mock-steam.mjs | Out-Null
    Start-Sleep -Seconds 1

    $mockIp = docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" bench-mock-steam
    Write-Host "Mock Steam server running at $mockIp (pinned as api.steampowered.com)"

    $allResults = @()
    foreach ($entry in @(
        @{ impl = "nest"; image = "sa-steam-proxy:nest-bench" },
        @{ impl = "rust"; image = "sa-steam-proxy:rust-bench" }
    )) {
        foreach ($sc in @("parity", "idle", "cache-hit", "cache-miss")) {
            $allResults += Run-Scenario $entry.impl $entry.image $sc $mockIp
        }
    }

    $allResults | ConvertTo-Json -Depth 8 | Out-File -Encoding utf8 (Join-Path $OutDir "summary.json")
    Write-Host "`nAll benchmark results written to $OutDir\summary.json"
} finally {
    Cleanup
}
