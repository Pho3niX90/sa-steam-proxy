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

interface CacheEntry {
  data: any;
  statusCode: number;
  expires: number;
}

interface ProxyResult {
  data?: any;
  statusCode: number;
  error?: 'rate_limited' | 'upstream_error' | 'nok' | 'decompression_failed';
}

@Injectable()
export class SteamProxyService {
  private readonly logger = new Logger(SteamProxyService.name);
  private readonly pool: Pool;
  private readonly cache = new Map<string, CacheEntry>();

  private requestTimestamps: number[] = [];
  private isRateLimited = false;
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
    this.pool = new Pool(STEAM_API_HOST, {
      connections: 100,
      pipelining: 1,
      keepAliveTimeout: 60_000,
    });

    this.logger.log('SteamProxyService initialized using undici.Pool');
  }

  get healthStatus() {
    this.cleanupOldRequests();
    return {
      healthy: !this.isRateLimited,
      rateLimited: this.isRateLimited,
      requestsPerMinute: this.requestTimestamps.length,
      backoff: this.retryBackoff,
      retryIn: Math.max(Math.ceil((this.nextProbeAt - Date.now()) / 1000), 0),
    };
  }

  getMetrics() {
    return { ...this.metrics };
  }

  async proxy(originalPath: string): Promise<ProxyResult> {
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

        const rawText = raw.toString('utf-8');

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

      if (statusCode === 429) {
        this.handleRateLimit(originalPath, headers['retry-after']);
        return { error: 'rate_limited', statusCode };
      }

      if (statusCode >= 400) {
        this.metrics.failure++;
        this.logger.warn(`Steam returned ${statusCode} on ${originalPath}`);
        return { error: 'upstream_error', statusCode };
      }

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
    if (!this.isRateLimited) return;
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

      if (res.statusCode < 400) {
        this.isRateLimited = false;
        this.lastFailurePath = '';
        this.retryBackoff = MIN_RETRY_BACKOFF_SECONDS;
        this.nextProbeAt = 0;

        if (this.rateLimitStart) {
          const duration = ((Date.now() - this.rateLimitStart) / 1000).toFixed(1);
          this.logger.log(`Rate limit lifted after ${duration}s`);
          this.rateLimitStart = undefined;
        }
      } else if (res.statusCode === 429) {
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

  private cleanupOldRequests() {
    const cutoff = Date.now() - ONE_MINUTE;
    this.requestTimestamps = this.requestTimestamps.filter(t => t > cutoff);
  }

  private setCache(key: string, value: CacheEntry) {
    this.evictExpiredCacheEntries();
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      // Drop oldest entry (Map preserves insertion order).
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
    this.nextProbeAt = Date.now() + (this.retryBackoff * 1000);
  }

  async onModuleDestroy() {
    await this.pool.close();
  }
}