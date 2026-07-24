import { readFileSync } from 'fs';
import { join } from 'path';

export type ProxyBuildInfo = {
  /** Semver from APP_VERSION env or package.json */
  version: string;
  /** Optional git commit / build id */
  gitSha: string | null;
  /** Image ref or tag when set by the orchestrator */
  imageTag: string | null;
};

let cached: ProxyBuildInfo | null = null;

function readPackageVersion(): string {
  try {
    const pkgPath = join(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return (pkg.version || '').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function optionalEnv(...keys: string[]): string | null {
  for (const key of keys) {
    const v = (process.env[key] || '').trim();
    if (v) return v;
  }
  return null;
}

/** Resolve once per process — safe for /healthz and /ready hot paths. */
export function getProxyBuildInfo(): ProxyBuildInfo {
  if (cached) return cached;
  cached = {
    version: optionalEnv('APP_VERSION', 'npm_package_version') || readPackageVersion(),
    gitSha: optionalEnv('GIT_SHA', 'GITHUB_SHA', 'COMMIT_SHA'),
    imageTag: optionalEnv('IMAGE_TAG', 'STEAM_PROXY_IMAGE'),
  };
  return cached;
}

/** Headers for every health/status response so ops can confirm the rolled image. */
export function proxyVersionHeaders(): Record<string, string> {
  const info = getProxyBuildInfo();
  const headers: Record<string, string> = {
    'X-Proxy-Version': info.version,
  };
  if (info.gitSha) headers['X-Git-Sha'] = info.gitSha;
  if (info.imageTag) headers['X-Image-Tag'] = info.imageTag;
  return headers;
}
