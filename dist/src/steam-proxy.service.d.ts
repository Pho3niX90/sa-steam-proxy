export declare class SteamProxyService {
    private readonly logger;
    private readonly pool;
    private readonly cache;
    private requestTimestamps;
    private isRateLimited;
    private lastFailurePath;
    private retryCounter;
    private retryBackoff;
    private rateLimitStart?;
    private metrics;
    constructor();
    get healthStatus(): {
        healthy: boolean;
        rateLimited: boolean;
        requestsPerMinute: number;
        backoff: number;
        retryIn: number;
    };
    getMetrics(): {
        total: number;
        success: number;
        failure: number;
        lastDurationMs: number;
    };
    proxy(originalPath: string): Promise<any>;
    checkRateLimiting(): Promise<void>;
    private cleanupOldRequests;
    private handleRateLimit;
}
