import fs from 'node:fs';

const INTERVAL_MS = Number.parseInt(process.env.INTERVAL_MS || '500', 10);
const DURATION_MS = Number.parseInt(process.env.DURATION_MS || '10000', 10);
const HZ = 100;

function readSample() {
  const status = fs.readFileSync('/proc/1/status', 'utf8');
  const stat = fs.readFileSync('/proc/1/stat', 'utf8');
  const match = (key) => {
    const m = status.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) : 0;
  };
  const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const utime = Number(afterComm[11]) || 0;
  const stime = Number(afterComm[12]) || 0;
  return {
    ts: Date.now(),
    rssKb: match('VmRSS'),
    hwmKb: match('VmHWM'),
    threads: match('Threads'),
    cpuTicks: utime + stime,
  };
}

const samples = [];
const first = readSample();
samples.push(first);

const endAt = Date.now() + DURATION_MS;

function finish() {
  let last = samples[samples.length - 1];
  try {
    last = readSample();
    samples.push(last);
  } catch {
    // target process exited
  }
  const wallSec = Math.max((last.ts - first.ts) / 1000, 0.001);
  const cpuSec = Math.max(last.cpuTicks - first.cpuTicks, 0) / HZ;
  const rssAvgMb =
    samples.reduce((acc, s) => acc + s.rssKb, 0) / samples.length / 1024;
  const rssPeakMb = Math.max(...samples.map((s) => s.hwmKb)) / 1024;
  const threadsMax = Math.max(...samples.map((s) => s.threads));

  console.log(
    JSON.stringify({
      samples: samples.length,
      wallSec: Number(wallSec.toFixed(2)),
      rssAvgMb: Number(rssAvgMb.toFixed(2)),
      rssPeakMb: Number(rssPeakMb.toFixed(2)),
      cpuPct: Number(((cpuSec / wallSec) * 100).toFixed(2)),
      threads: threadsMax,
    }),
  );
  process.exit(0);
}

process.on('SIGTERM', finish);
process.on('SIGINT', finish);

const timer = setInterval(() => {
  try {
    samples.push(readSample());
  } catch {
    clearInterval(timer);
    finish();
    return;
  }
  if (Date.now() >= endAt) {
    clearInterval(timer);
    finish();
  }
}, INTERVAL_MS);
