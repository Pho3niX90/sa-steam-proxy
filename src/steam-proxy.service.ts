import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'undici';
import { gunzipSync } from 'zlib';
import { Buffer } from 'buffer';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const appendQuery = require('append-query');
const STEAM_API_HOST = 'http://api.steampowered.com';
const SAFE_PROBE_PATH = '/ISteamWebAPIUtil/GetServerInfo/v0001/';
const CACHE_TTL_MS = 60_000;
const ONE_MINUTE = 60_000;

interface CacheEntry {
  data: any;
  expires: number;
}

@Injectable()
export class SteamProxyService {
  private readonly logger = new Logger(SteamProxyService.name);
  private readonly pool: Pool;
  private readonly cache = new Map<string, CacheEntry>();

  private requestTimestamps: number[] = [];
  private isRateLimited = false;
  private lastFailurePath = '';
  private retryCounter = 0;
  private retryBackoff = 5;
  private rateLimitStart?: number;

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
      retryIn: this.retryBackoff - this.retryCounter,
    };
  }

  getMetrics() {
    return { ...this.metrics };
  }

  async proxy(originalPath: string): Promise<any> {
    this.cleanupOldRequests();
    this.requestTimestamps.push(Date.now());
    this.metrics.total++;

    const fullPath = appendQuery(originalPath);
    const cacheKey = fullPath;
    const now = Date.now();

    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > now) {
      this.logger.debug(`Cache HIT: ${originalPath}`);
      return cached.data;
    }

    if (this.isRateLimited) {
      this.logger.warn(`Blocked by rate limit: ${originalPath}`);
      return { error: 'rate_limited' };
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
            return { error: 'decompression_failed' };
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
        this.handleRateLimit(originalPath);
        return { error: 'rate_limited' };
      }

      if (statusCode >= 400) {
        this.metrics.failure++;
        this.logger.warn(`Steam returned ${statusCode} on ${originalPath}`);
        return { error: 'nok' };
      }

      this.metrics.success++;
      this.cache.set(cacheKey, { data, expires: now + CACHE_TTL_MS });

      return data;
    } catch (err) {
      this.metrics.failure++;
      this.metrics.lastDurationMs = Date.now() - start;
      this.logger.error(`Steam fetch error: ${err.message}`);
      return { error: 'nok' };
    }
  }

  async checkRateLimiting() {
    if (!this.isRateLimited) return;

    this.retryCounter++;
    if (this.retryCounter < this.retryBackoff) return;

    this.retryCounter = 0;

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
        const secs = parseInt(retryAfter as string, 10);
        if (!isNaN(secs)) {
          this.retryBackoff = Math.max(secs, 5);
          this.logger.warn(`Retry-After header: ${secs}s`);
        }
      }

      if (res.statusCode < 400) {
        this.isRateLimited = false;
        this.lastFailurePath = '';
        this.retryBackoff = 5;
        this.retryCounter = 0;

        if (this.rateLimitStart) {
          const duration = ((Date.now() - this.rateLimitStart) / 1000).toFixed(1);
          this.logger.log(`Rate limit lifted after ${duration}s`);
          this.rateLimitStart = undefined;
        }
      } else if (res.statusCode === 429) {
        this.retryBackoff *= 2;
        this.logger.warn(`Still rate-limited. Increasing backoff to ${this.retryBackoff}s.`);
      } else {
        this.logger.warn(`Unexpected probe status: ${res.statusCode}`);
      }
    } catch (err) {
      this.logger.error(`Rate-limit probe error: ${err.message}`);
    }
  }

  private cleanupOldRequests() {
    const cutoff = Date.now() - ONE_MINUTE;
    this.requestTimestamps = this.requestTimestamps.filter(t => t > cutoff);
  }

  private handleRateLimit(path: string) {
    this.metrics.failure++;
    this.lastFailurePath = path;
    if (!this.isRateLimited) {
      this.isRateLimited = true;
      this.rateLimitStart = Date.now();
    }
  }
}