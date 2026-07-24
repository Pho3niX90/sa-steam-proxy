import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'undici';
import { gunzipSync } from 'zlib';
import { Buffer } from 'buffer';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const appendQuery = require('append-query');
const STEAM_API_HOST = 'http://api.steampowered.com';
const SAFE_PROBE_PATH = '/ISteamWebAPIUtil/GetServerInfo/v0001/';
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 5_000;
const ONE_MINUTE = 60_000;
const MIN_RETRY_BACKOFF_SECONDS = 5;
const MAX_RETRY_BACKOFF_SECONDS = 300;
/** Consecutive auth-style failures before marking the proxy not-ready. */
const BAD_KEY_FAILURE_THRESHOLD = 3;

interface CacheEntry {
  data: any;
  statusCode: number;
  expires: number;
}

interface ProxyResult {
  data?: any;
  statusCode: number;
  error?: 'rate_limited' | 'upstream_error' | 'nok' | 'decompression_failed' | 'bad_key';
}

export type ReadyReason = 'rate_limited' | 'bad_key';

export type ReadyStatus = {
  /** Process is up — always true when this handler runs. */
  alive: true;
  /** Real readiness: can usefully serve Steam traffic. */
  ready: boolean;
  status: 'ok' | ReadyReason;
  reasons: ReadyReason[];
  rateLimited: boolean;
  badKey: boolean;
  requestsPerMinute: number;
  backoff: number;
  retryIn: number;
  authFailures: number;
};

@Injectable()
export class SteamProxyService {
  private readonly logger = new Logger(SteamProxyService.name);
  private readonly pool: Pool;
  private readonly cache = new Map<string, CacheEntry>();

  private requestTimestamps: number[] = [];
  private isRateLimited = false;
  private isBadKey = false;
  private consecutiveAuthFailures = 0;
  private lastFailurePath = '';
  private retryBackoff = MIN_RETRY_BACKOFF_SECONDS;
  private rateLimitStart?: number;
  private nextProbeAt = 0;

  private metrics = {
    total: 0,
    success: 0,
    failure: 0,
    lastDurationMs: 0,
  };

  constructor() {
    const sourceIp = (process.env.SOURCE_IP || '').trim();
    this.pool = new Pool(STEAM_API_HOST, {
      connections: 100,
      pipelining: 1,
      keepAliveTimeout: 60_000,
      ...(sourceIp
        ? {
            connect: {
              localAddress: sourceIp,
            },
          }
        : {}),
    });

    this.logger.log(
      sourceIp
        ? `SteamProxyService initialized using undici.Pool (SOURCE_IP=${sourceIp})`
        : 'SteamProxyService initialized using undici.Pool',
    );
  }

  /** Liveness snapshot — process online only. */
  get livenessStatus() {
    this.cleanupOldRequests();
    return {
      alive: true as const,
      requestsPerMinute: this.requestTimestamps.length,
    };
  }

  /**
   * Readiness: not rate-limited and not stuck on a bad/rejected Steam key.
   * Steam rarely returns HTTP 429; we also treat Retry-After and rate-limit
   * wording in bodies as rate-limited, and 401 / auth-style 403 as bad_key.
   */
  get readyStatus(): ReadyStatus {
    this.cleanupOldRequests();
    const reasons: ReadyReason[] = [];
    if (this.isRateLimited) reasons.push('rate_limited');
    if (this.isBadKey) reasons.push('bad_key');
    const ready = reasons.length === 0;
    return {
      alive: true,
      ready,
      status: ready ? 'ok' : reasons[0],
      reasons,
      rateLimited: this.isRateLimited,
      badKey: this.isBadKey,
      requestsPerMinute: this.requestTimestamps.length,
      backoff: this.retryBackoff,
      retryIn: Math.max(Math.ceil((this.nextProbeAt - Date.now()) / 1000), 0),
      authFailures: this.consecutiveAuthFailures,
    };
  }

  /** @deprecated Prefer readyStatus / livenessStatus. Kept for older callers. */
  get healthStatus() {
    const ready = this.readyStatus;
    return {
      healthy: ready.ready,
      rateLimited: ready.rateLimited,
      requestsPerMinute: ready.requestsPerMinute,
      backoff: ready.backoff,
      retryIn: ready.retryIn,
    };
  }

  getMetrics() {
    return { ...this.metrics };
  }

  async proxy(originalPath: string): Promise<ProxyResult> {
    const pathOnly = originalPath.split('?')[0] || '/';
    if (pathOnly === '/healthz' || pathOnly === '/ready' || pathOnly === '/metrics') {
      this.logger.warn(`Refusing to proxy reserved path to Steam: ${pathOnly}`);
      return { error: 'nok', statusCode: 404 };
    }

    this.cleanupOldRequests();
    this.requestTimestamps.push(Date.now());
    this.metrics.total++;

    const fullPath = appendQuery(originalPath);
    const cacheKey = fullPath;
    const now = Date.now();

    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > now) {
      this.logger.debug(`Cache HIT: ${originalPath}`);
      return { data: cached.data, statusCode: cached.statusCode };
    }

    if (this.isRateLimited) {
      this.logger.warn(`Blocked by rate limit: ${originalPath}`);
      return { error: 'rate_limited', statusCode: 429 };
    }

    // Do not short-circuit bad_key here — allow traffic so a rotated key can recover.
    // /ready already reports not-ready while isBadKey is set.

    const start = Date.now();

    try {
      const result = await this.pool.request({
        method: 'GET',
        path: fullPath,
        headers: {
          'accept-encoding': 'gzip',
        },
      });

      const duration = Date.now() - start;
      this.metrics.lastDurationMs = duration;

      const { statusCode, headers, body } = result;

      let data: any;
      let rawText = '';
      try {
        const contentEncoding = headers['content-encoding'] || '';
        const contentType = headers['content-type'] || '';

        const rawBuffer = await body.arrayBuffer();
        let raw = Buffer.from(rawBuffer);

        if (contentEncoding.includes('gzip')) {
          try {
            raw = gunzipSync(raw);
          } catch (decompErr) {
            this.logger.error(`Decompression failed: ${decompErr.message}`);
            return { error: 'decompression_failed', statusCode: 502 };
          }
        }

        rawText = raw.toString('utf-8');

        if (contentType.includes('application/json') && rawText.trim() !== '') {
          try {
            data = JSON.parse(rawText);
          } catch {
            this.logger.warn(`Failed to parse JSON. Raw body: ${rawText}`);
            data = rawText;
          }
        } else {
          data = rawText;
        }
      } catch (err) {
        this.logger.error(`Steam body read error: ${err.message}`);
        data = null;
      }

      const classified = this.classifySteamFailure(statusCode, headers, rawText);

      if (classified === 'rate_limited') {
        this.handleRateLimit(originalPath, headers['retry-after']);
        return { error: 'rate_limited', statusCode: 429 };
      }

      if (classified === 'bad_key') {
        this.handleAuthFailure(originalPath, statusCode);
        return { error: 'bad_key', statusCode };
      }

      if (statusCode >= 400) {
        this.metrics.failure++;
        this.logger.warn(`Steam returned ${statusCode} on ${originalPath}`);
        return { error: 'upstream_error', statusCode };
      }

      this.clearFailureState();
      this.metrics.success++;
      this.setCache(cacheKey, { data, statusCode, expires: now + CACHE_TTL_MS });

      return { data, statusCode };
    } catch (err) {
      this.metrics.failure++;
      this.metrics.lastDurationMs = Date.now() - start;
      this.logger.error(`Steam fetch error: ${err.message}`);
      return { error: 'nok', statusCode: 502 };
    }
  }

  async checkRateLimiting() {
    if (!this.isRateLimited && !this.isBadKey) return;
    if (Date.now() < this.nextProbeAt) return;

    try {
      const res = await this.pool.request({
        method: 'GET',
        path: SAFE_PROBE_PATH,
        headers: {
          'accept-encoding': 'gzip',
        },
      });

      const retryAfter = res.headers['retry-after'];
      if (retryAfter) {
        this.applyRetryAfter(retryAfter);
      }

      // GetServerInfo does not need a key; success only clears rate-limit, not bad_key.
      if (res.statusCode < 400) {
        if (this.isRateLimited) {
          this.isRateLimited = false;
          this.lastFailurePath = '';
          this.retryBackoff = MIN_RETRY_BACKOFF_SECONDS;
          this.nextProbeAt = 0;
          if (this.rateLimitStart) {
            const duration = ((Date.now() - this.rateLimitStart) / 1000).toFixed(1);
            this.logger.log(`Rate limit lifted after ${duration}s`);
            this.rateLimitStart = undefined;
          }
        }
        // bad_key stays until a real keyed request succeeds.
      } else if (this.classifySteamFailure(res.statusCode, res.headers, '') === 'rate_limited') {
        if (!retryAfter) {
          this.retryBackoff = Math.min(this.retryBackoff * 2, MAX_RETRY_BACKOFF_SECONDS);
        }
        this.scheduleNextProbe();
        this.logger.warn(`Still rate-limited. Increasing backoff to ${this.retryBackoff}s.`);
      } else {
        this.scheduleNextProbe();
        this.logger.warn(`Unexpected probe status: ${res.statusCode}`);
      }
    } catch (err) {
      this.scheduleNextProbe();
      this.logger.error(`Rate-limit probe error: ${err.message}`);
    }
  }

  /**
   * Steam historically does not use 429 reliably. Detect:
   * - 429 or Retry-After → rate limited
   * - body rate-limit wording → rate limited
   * - 401 / access-denied style 403 → bad key
   * - bare 403 (common for invalid publisher keys) → bad key
   */
  private classifySteamFailure(
    statusCode: number,
    headers: Record<string, string | string[] | undefined>,
    bodyText: string,
  ): 'rate_limited' | 'bad_key' | null {
    const retryAfter = headers['retry-after'];
    const body = (bodyText || '').toLowerCase();

    if (statusCode === 429 || retryAfter) {
      return 'rate_limited';
    }
    if (
      /too many requests|rate.?limit|request limit|try again later/.test(body)
    ) {
      return 'rate_limited';
    }

    if (statusCode === 401) {
      return 'bad_key';
    }
    if (statusCode === 403) {
      if (/access is denied|invalid.*key|forbidden|unauthorized|api key/.test(body)) {
        return 'bad_key';
      }
      // Steam often returns empty-body 403 for rejected keys.
      return 'bad_key';
    }

    return null;
  }

  private handleAuthFailure(path: string, statusCode: number) {
    this.metrics.failure++;
    this.consecutiveAuthFailures++;
    this.lastFailurePath = path;
    if (this.consecutiveAuthFailures >= BAD_KEY_FAILURE_THRESHOLD && !this.isBadKey) {
      this.isBadKey = true;
      this.logger.error(
        `Marked bad_key after ${this.consecutiveAuthFailures} auth failures ` +
          `(last HTTP ${statusCode} on ${path})`,
      );
    }
  }

  private clearFailureState() {
    this.consecutiveAuthFailures = 0;
    if (this.isBadKey) {
      this.logger.log('Cleared bad_key after successful Steam response');
    }
    this.isBadKey = false;
  }

  private cleanupOldRequests() {
    const cutoff = Date.now() - ONE_MINUTE;
    this.requestTimestamps = this.requestTimestamps.filter((t) => t > cutoff);
  }

  private setCache(key: string, value: CacheEntry) {
    this.evictExpiredCacheEntries();
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, value);
  }

  private evictExpiredCacheEntries() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expires <= now) {
        this.cache.delete(key);
      }
    }
  }

  private handleRateLimit(path: string, retryAfterHeader?: string | string[]) {
    this.metrics.failure++;
    this.lastFailurePath = path;
    if (!this.isRateLimited) {
      this.isRateLimited = true;
      this.rateLimitStart = Date.now();
      this.logger.warn(`Entered rate_limited state on ${path}`);
    }
    if (retryAfterHeader) {
      this.applyRetryAfter(retryAfterHeader);
    }
    this.scheduleNextProbe();
  }

  private applyRetryAfter(retryAfter: string | string[]) {
    const headerValue = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
    const secs = parseInt(headerValue, 10);
    if (isNaN(secs)) {
      return;
    }
    this.retryBackoff = Math.min(
      Math.max(secs, MIN_RETRY_BACKOFF_SECONDS),
      MAX_RETRY_BACKOFF_SECONDS,
    );
    this.logger.warn(`Retry-After header: ${secs}s`);
  }

  private scheduleNextProbe() {
    this.nextProbeAt = Date.now() + this.retryBackoff * 1000;
  }

  async onModuleDestroy() {
    await this.pool.close();
  }
}
