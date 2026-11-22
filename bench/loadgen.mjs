import http from 'node:http';

const TARGET_HOST = process.env.TARGET_HOST || 'proxy';
const TARGET_PORT = Number.parseInt(process.env.TARGET_PORT || '8080', 10);
const MODE = process.env.MODE || 'cache-hit';
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || '32', 10);
const DURATION_SECS = Number.parseInt(process.env.DURATION_SECS || '20', 10);

const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY * 2 });

function requestOnce(path) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const req = http.request(
      {
        host: TARGET_HOST,
        port: TARGET_PORT,
        path,
        method: 'GET',
        agent,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const elapsedNs = Number(process.hrtime.bigint() - start);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            latencyMs: elapsedNs / 1e6,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function runParity() {
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    if (!ok) {
      console.error(`PARITY FAIL [${name}]: ${detail}`);
    }
  };

  // 1. /healthz
  const hz = await requestOnce('/healthz');
  check(
    'healthz',
    hz.status === 200 &&
      hz.body === 'ok' &&
      hz.headers['x-alive'] === 'true' &&
      Boolean(hz.headers['x-proxy-version']) &&
      hz.headers['x-requests-per-minute'] === '0',
    JSON.stringify({ status: hz.status, body: hz.body, headers: hz.headers }),
  );

  // 2. /ready
  const rd = await requestOnce('/ready');
  check(
    'ready_ok',
    rd.status === 200 &&
      rd.body === 'ok' &&
      rd.headers['x-ready'] === 'true' &&
      rd.headers['x-ready-status'] === 'ok' &&
      rd.headers['x-ratelimit-status'] === 'ok' &&
      rd.headers['x-bad-key'] === 'false' &&
      rd.headers['x-backoff'] === '5' &&
      rd.headers['x-retry-in'] === '0' &&
      rd.headers['x-auth-failures'] === '0',
    JSON.stringify({ status: rd.status, body: rd.body, headers: rd.headers }),
  );

  // 3. Gzip JSON proxy
  const px = await requestOnce('/ISteamUser/GetPlayerSummaries/v0002/?key=AAAABBBBCCCCDDDD1111222233334444&steamids=76561197960435530');
  let parsed = null;
  try {
    parsed = JSON.parse(px.body);
  } catch {}
  check(
    'gzip_json_proxy',
    px.status === 200 &&
      (px.headers['content-type'] || '').includes('application/json') &&
      parsed?.response?.players?.[0]?.steamid === '76561197960435530',
    JSON.stringify({ status: px.status, ct: px.headers['content-type'] }),
  );

  // 4. Plain text proxy
  const pl = await requestOnce('/test/plain');
  check('plain_text_proxy', pl.status === 200 && pl.body === 'plain-steam-body', `${pl.status} ${pl.body}`);

  // 5. Corrupt gzip -> 502 decompression_failed
  const cg = await requestOnce('/test/corrupt-gzip');
  check(
    'corrupt_gzip_502',
    cg.status === 502 &&
      cg.body === 'decompression_failed' &&
      cg.headers['x-status-message'] === 'decompression_failed' &&
      cg.headers['x-ratelimit-status'] === 'ok' &&
      cg.headers['x-bad-key'] === 'false',
    JSON.stringify({ status: cg.status, body: cg.body, headers: cg.headers }),
  );

  // 6. 3x bad_key 403 -> /ready 503 bad_key -> recovered by 200
  for (let i = 0; i < 3; i++) {
    const bk = await requestOnce(`/test/bad-key-403?n=${i}`);
    check(
      `bad_key_403_${i}`,
      bk.status === 403 && bk.body === 'bad_key' && bk.headers['x-bad-key'] === 'true',
      JSON.stringify({ status: bk.status, body: bk.body }),
    );
  }
  const rdBk = await requestOnce('/ready');
  check(
    'ready_bad_key_503',
    rdBk.status === 503 &&
      rdBk.body === 'bad_key' &&
      rdBk.headers['x-bad-key'] === 'true' &&
      rdBk.headers['x-auth-failures'] === '3',
    JSON.stringify({ status: rdBk.status, body: rdBk.body, headers: rdBk.headers }),
  );
  // Recover via 200
  const rec = await requestOnce('/ISteamUser/GetPlayerSummaries/v0002/?key=GOOD&steamids=99');
  const rdRec = await requestOnce('/ready');
  check(
    'bad_key_recovery',
    rec.status === 200 && rdRec.status === 200 && rdRec.body === 'ok' && rdRec.headers['x-auth-failures'] === '0',
    JSON.stringify({ recStatus: rec.status, rdStatus: rdRec.status, rdBody: rdRec.body }),
  );

  // 7. Bare 403 -> 429 rate_limited -> /ready 503 rate_limited
  const rl = await requestOnce('/test/bare-403');
  const rdRl = await requestOnce('/ready');
  check(
    'bare_403_rate_limited',
    rl.status === 429 &&
      rl.body === 'rate_limited' &&
      rl.headers['x-ratelimit-status'] === 'limited' &&
      rdRl.status === 503 &&
      rdRl.body === 'rate_limited' &&
      rdRl.headers['x-ratelimit-status'] === 'limited',
    JSON.stringify({ rl: rl.status, rlBody: rl.body, rd: rdRl.status, rdBody: rdRl.body }),
  );

  // 8. /metrics JSON structure
  const mt = await requestOnce('/metrics');
  const mtJson = JSON.parse(mt.body);
  check(
    'metrics_json',
    mt.status === 200 &&
      typeof mtJson.total === 'number' &&
      typeof mtJson.success === 'number' &&
      typeof mtJson.failure === 'number' &&
      typeof mtJson.lastDurationMs === 'number' &&
      typeof mtJson.build?.version === 'string',
    mt.body,
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(JSON.stringify({ mode: 'parity', passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}

async function runLoad() {
  if (MODE === 'cache-hit') {
    // Warm the 50 hot cache entries
    for (let i = 0; i < 50; i++) {
      await requestOnce(`/ISteamUser/GetPlayerSummaries/v0002/?key=BENCHKEY000000000000000000000000&steamids=hot_${i}`);
    }
  }

  const endAt = Date.now() + DURATION_SECS * 1000;
  let seq = 0;
  let okCount = 0;
  let errCount = 0;
  const statusCounts = {};
  let sampleError = null;
  const latencies = [];

  const startedAt = Date.now();
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (Date.now() < endAt) {
      const id = seq++;
      const path =
        MODE === 'cache-hit'
          ? `/ISteamUser/GetPlayerSummaries/v0002/?key=BENCHKEY000000000000000000000000&steamids=hot_${id % 50}`
          : `/ISteamUser/GetPlayerSummaries/v0002/?key=BENCHKEY000000000000000000000000&steamids=miss_${id}`;
      try {
        const res = await requestOnce(path);
        const key = String(res.status);
        statusCounts[key] = (statusCounts[key] || 0) + 1;
        if (res.status === 200) {
          okCount++;
          latencies.push(res.latencyMs);
        } else {
          errCount++;
          if (!sampleError) sampleError = `HTTP ${res.status}: ${res.body.slice(0, 120)}`;
        }
      } catch (err) {
        errCount++;
        statusCounts.net_err = (statusCounts.net_err || 0) + 1;
        if (!sampleError) sampleError = String(err?.message || err);
      }
    }
  });

  await Promise.all(workers);
  const elapsedSec = (Date.now() - startedAt) / 1000;
  latencies.sort((a, b) => a - b);

  const summary = {
    mode: MODE,
    concurrency: CONCURRENCY,
    durationSec: Number(elapsedSec.toFixed(2)),
    totalRequests: okCount + errCount,
    okCount,
    errCount,
    statusCounts,
    sampleError,
    rps: Number((okCount / elapsedSec).toFixed(1)),
    p50Ms: Number(percentile(latencies, 50).toFixed(2)),
    p95Ms: Number(percentile(latencies, 95).toFixed(2)),
    p99Ms: Number(percentile(latencies, 99).toFixed(2)),
    maxMs: Number(percentile(latencies, 100).toFixed(2)),
  };
  console.log(JSON.stringify(summary));
}

if (MODE === 'parity') {
  runParity();
} else {
  runLoad();
}
