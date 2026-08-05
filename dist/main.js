/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ([
/* 0 */,
/* 1 */
/***/ ((module) => {

module.exports = require("@nestjs/core");

/***/ }),
/* 2 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.AppModule = void 0;
const common_1 = __webpack_require__(3);
const app_controller_1 = __webpack_require__(4);
const schedule_1 = __webpack_require__(5);
const steam_proxy_service_1 = __webpack_require__(7);
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [schedule_1.ScheduleModule.forRoot()],
        controllers: [app_controller_1.AppController],
        providers: [steam_proxy_service_1.SteamProxyService],
    })
], AppModule);


/***/ }),
/* 3 */
/***/ ((module) => {

module.exports = require("@nestjs/common");

/***/ }),
/* 4 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var _a, _b, _c, _d, _e, _f;
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.AppController = void 0;
const common_1 = __webpack_require__(3);
const schedule_1 = __webpack_require__(5);
const fastify_1 = __webpack_require__(6);
const steam_proxy_service_1 = __webpack_require__(7);
const version_1 = __webpack_require__(13);
const RESERVED_PATHS = new Set(['/healthz', '/ready', '/metrics']);
let AppController = class AppController {
    constructor(steamProxy) {
        this.steamProxy = steamProxy;
    }
    getLiveness(res) {
        this.sendLiveness(res);
    }
    getReady(res) {
        this.sendReady(res);
    }
    getMetrics(res) {
        res
            .status(200)
            .headers((0, version_1.proxyVersionHeaders)())
            .send({
            ...this.steamProxy.getMetrics(),
            build: (0, version_1.getProxyBuildInfo)(),
        });
    }
    async proxy(req, res) {
        const path = pathnameOf(req);
        if (path === '/healthz') {
            this.sendLiveness(res);
            return;
        }
        if (path === '/ready') {
            this.sendReady(res);
            return;
        }
        if (path === '/metrics') {
            res
                .status(200)
                .headers((0, version_1.proxyVersionHeaders)())
                .send({
                ...this.steamProxy.getMetrics(),
                build: (0, version_1.getProxyBuildInfo)(),
            });
            return;
        }
        if (RESERVED_PATHS.has(path)) {
            res.status(404).send('not_found');
            return;
        }
        const result = await this.steamProxy.proxy(req.url);
        if (result?.error) {
            res
                .status(result.statusCode ||
                (result.error === 'rate_limited' ? 429 : result.error === 'bad_key' ? 403 : 500))
                .header('X-RateLimit-Status', result.error === 'rate_limited' ? 'limited' : 'ok')
                .header('X-Bad-Key', result.error === 'bad_key' ? 'true' : 'false')
                .header('X-Status-Message', result.error)
                .send(result.error);
        }
        else {
            res.status(result.statusCode || 200).send(result.data);
        }
    }
    sendLiveness(res) {
        const live = this.steamProxy.livenessStatus;
        res
            .status(200)
            .headers({
            ...(0, version_1.proxyVersionHeaders)(),
            'X-Alive': 'true',
            'X-Requests-Per-Minute': live.requestsPerMinute.toString(),
        })
            .send('ok');
    }
    sendReady(res) {
        const ready = this.steamProxy.readyStatus;
        const body = ready.ready ? 'ok' : ready.status;
        res
            .status(ready.ready ? 200 : 503)
            .headers({
            ...(0, version_1.proxyVersionHeaders)(),
            'X-Ready': ready.ready ? 'true' : 'false',
            'X-Ready-Status': ready.status,
            'X-RateLimit-Status': ready.rateLimited ? 'limited' : 'ok',
            'X-Bad-Key': ready.badKey ? 'true' : 'false',
            'X-Requests-Per-Minute': ready.requestsPerMinute.toString(),
            'X-Backoff': ready.backoff.toString(),
            'X-Retry-In': ready.retryIn.toString(),
            'X-Auth-Failures': ready.authFailures.toString(),
        })
            .send(body);
    }
    async checkRateLimit() {
        await this.steamProxy.checkRateLimiting();
    }
    restart() {
        console.log('[CRON] Midnight restart');
        process.exit();
    }
};
exports.AppController = AppController;
__decorate([
    (0, common_1.Get)('/healthz'),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [typeof (_b = typeof fastify_1.FastifyReply !== "undefined" && fastify_1.FastifyReply) === "function" ? _b : Object]),
    __metadata("design:returntype", void 0)
], AppController.prototype, "getLiveness", null);
__decorate([
    (0, common_1.Get)('/ready'),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [typeof (_c = typeof fastify_1.FastifyReply !== "undefined" && fastify_1.FastifyReply) === "function" ? _c : Object]),
    __metadata("design:returntype", void 0)
], AppController.prototype, "getReady", null);
__decorate([
    (0, common_1.Get)('/metrics'),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [typeof (_d = typeof fastify_1.FastifyReply !== "undefined" && fastify_1.FastifyReply) === "function" ? _d : Object]),
    __metadata("design:returntype", void 0)
], AppController.prototype, "getMetrics", null);
__decorate([
    (0, common_1.Get)('/*'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [typeof (_e = typeof fastify_1.FastifyRequest !== "undefined" && fastify_1.FastifyRequest) === "function" ? _e : Object, typeof (_f = typeof fastify_1.FastifyReply !== "undefined" && fastify_1.FastifyReply) === "function" ? _f : Object]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "proxy", null);
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_5_MINUTES),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AppController.prototype, "checkRateLimit", null);
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_DAY_AT_MIDNIGHT),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], AppController.prototype, "restart", null);
exports.AppController = AppController = __decorate([
    (0, common_1.Controller)(),
    __metadata("design:paramtypes", [typeof (_a = typeof steam_proxy_service_1.SteamProxyService !== "undefined" && steam_proxy_service_1.SteamProxyService) === "function" ? _a : Object])
], AppController);
function pathnameOf(req) {
    const raw = req.url || '/';
    const q = raw.indexOf('?');
    return q === -1 ? raw : raw.slice(0, q);
}


/***/ }),
/* 5 */
/***/ ((module) => {

module.exports = require("@nestjs/schedule");

/***/ }),
/* 6 */
/***/ ((module) => {

module.exports = require("fastify");

/***/ }),
/* 7 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var SteamProxyService_1;
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.SteamProxyService = void 0;
const common_1 = __webpack_require__(3);
const undici_1 = __webpack_require__(8);
const zlib_1 = __webpack_require__(9);
const buffer_1 = __webpack_require__(10);
const steam_failure_1 = __webpack_require__(11);
const appendQuery = __webpack_require__(12);
const STEAM_API_HOST = 'http://api.steampowered.com';
const SAFE_PROBE_PATH = '/ISteamWebAPIUtil/GetServerInfo/v0001/';
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 5_000;
const ONE_MINUTE = 60_000;
const MIN_RETRY_BACKOFF_SECONDS = 5;
const MAX_RETRY_BACKOFF_SECONDS = 300;
const BAD_KEY_FAILURE_THRESHOLD = 3;
let SteamProxyService = SteamProxyService_1 = class SteamProxyService {
    constructor() {
        this.logger = new common_1.Logger(SteamProxyService_1.name);
        this.cache = new Map();
        this.requestTimestamps = [];
        this.isRateLimited = false;
        this.isBadKey = false;
        this.consecutiveAuthFailures = 0;
        this.lastFailurePath = '';
        this.retryBackoff = MIN_RETRY_BACKOFF_SECONDS;
        this.nextProbeAt = 0;
        this.metrics = {
            total: 0,
            success: 0,
            failure: 0,
            lastDurationMs: 0,
        };
        const sourceIp = (process.env.SOURCE_IP || '').trim();
        this.pool = new undici_1.Pool(STEAM_API_HOST, {
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
        this.rpmCleanupTimer = setInterval(() => this.cleanupOldRequests(), 10_000);
        this.rpmCleanupTimer.unref?.();
        this.logger.log(sourceIp
            ? `SteamProxyService initialized using undici.Pool (SOURCE_IP=${sourceIp})`
            : 'SteamProxyService initialized using undici.Pool');
    }
    get livenessStatus() {
        this.cleanupOldRequests();
        return {
            alive: true,
            requestsPerMinute: this.requestTimestamps.length,
        };
    }
    get readyStatus() {
        this.cleanupOldRequests();
        const reasons = [];
        if (this.isRateLimited)
            reasons.push('rate_limited');
        if (this.isBadKey)
            reasons.push('bad_key');
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
    async proxy(originalPath) {
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
            this.logger.debug(`Cache HIT: ${(0, steam_failure_1.redactSteamPathForLog)(originalPath)}`);
            return { data: cached.data, statusCode: cached.statusCode };
        }
        if (this.isRateLimited) {
            this.logger.warn(`Blocked by rate limit: ${(0, steam_failure_1.redactSteamPathForLog)(originalPath)}`);
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
            let data;
            let rawText = '';
            try {
                const contentEncoding = headers['content-encoding'] || '';
                const contentType = headers['content-type'] || '';
                const rawBuffer = await body.arrayBuffer();
                let raw = buffer_1.Buffer.from(rawBuffer);
                if (contentEncoding.includes('gzip')) {
                    try {
                        raw = (0, zlib_1.gunzipSync)(raw);
                    }
                    catch (decompErr) {
                        this.logger.error(`Decompression failed: ${decompErr.message}`);
                        return { error: 'decompression_failed', statusCode: 502 };
                    }
                }
                rawText = raw.toString('utf-8');
                if (contentType.includes('application/json') && rawText.trim() !== '') {
                    try {
                        data = JSON.parse(rawText);
                    }
                    catch {
                        this.logger.warn(`Failed to parse JSON. Raw body: ${rawText}`);
                        data = rawText;
                    }
                }
                else {
                    data = rawText;
                }
            }
            catch (err) {
                this.logger.error(`Steam body read error: ${err.message}`);
                data = null;
            }
            const classified = (0, steam_failure_1.classifySteamFailure)(statusCode, headers, rawText);
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
                this.logger.warn(`Steam returned ${statusCode} on ${(0, steam_failure_1.redactSteamPathForLog)(originalPath)}`);
                return { error: 'upstream_error', statusCode };
            }
            this.clearFailureState();
            this.metrics.success++;
            this.setCache(cacheKey, { data, statusCode, expires: now + CACHE_TTL_MS });
            return { data, statusCode };
        }
        catch (err) {
            this.metrics.failure++;
            this.metrics.lastDurationMs = Date.now() - start;
            this.logger.error(`Steam fetch error: ${err.message}`);
            return { error: 'nok', statusCode: 502 };
        }
    }
    async checkRateLimiting() {
        if (!this.isRateLimited && !this.isBadKey)
            return;
        if (Date.now() < this.nextProbeAt)
            return;
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
            }
            else if ((0, steam_failure_1.classifySteamFailure)(res.statusCode, res.headers, '') === 'rate_limited') {
                if (!retryAfter) {
                    this.retryBackoff = Math.min(this.retryBackoff * 2, MAX_RETRY_BACKOFF_SECONDS);
                }
                this.scheduleNextProbe();
                this.logger.warn(`Still rate-limited. Increasing backoff to ${this.retryBackoff}s.`);
            }
            else {
                this.scheduleNextProbe();
                this.logger.warn(`Unexpected probe status: ${res.statusCode}`);
            }
        }
        catch (err) {
            this.scheduleNextProbe();
            this.logger.error(`Rate-limit probe error: ${err.message}`);
        }
    }
    handleAuthFailure(path, statusCode) {
        this.metrics.failure++;
        this.consecutiveAuthFailures++;
        this.lastFailurePath = path;
        if (this.consecutiveAuthFailures >= BAD_KEY_FAILURE_THRESHOLD && !this.isBadKey) {
            this.isBadKey = true;
            this.logger.error(`Marked bad_key after ${this.consecutiveAuthFailures} auth failures ` +
                `(last HTTP ${statusCode} on ${(0, steam_failure_1.redactSteamPathForLog)(path)})`);
        }
    }
    clearFailureState() {
        this.consecutiveAuthFailures = 0;
        if (this.isBadKey) {
            this.logger.log('Cleared bad_key after successful Steam response');
        }
        this.isBadKey = false;
    }
    cleanupOldRequests() {
        const cutoff = Date.now() - ONE_MINUTE;
        this.requestTimestamps = this.requestTimestamps.filter((t) => t > cutoff);
    }
    setCache(key, value) {
        this.evictExpiredCacheEntries();
        if (this.cache.size >= MAX_CACHE_ENTRIES) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey) {
                this.cache.delete(oldestKey);
            }
        }
        this.cache.set(key, value);
    }
    evictExpiredCacheEntries() {
        const now = Date.now();
        for (const [key, entry] of this.cache.entries()) {
            if (entry.expires <= now) {
                this.cache.delete(key);
            }
        }
    }
    handleRateLimit(path, retryAfterHeader) {
        this.metrics.failure++;
        this.lastFailurePath = path;
        if (!this.isRateLimited) {
            this.isRateLimited = true;
            this.rateLimitStart = Date.now();
            this.logger.warn(`Entered rate_limited state on ${(0, steam_failure_1.redactSteamPathForLog)(path)}`);
        }
        if (retryAfterHeader) {
            this.applyRetryAfter(retryAfterHeader);
        }
        this.scheduleNextProbe();
    }
    applyRetryAfter(retryAfter) {
        const headerValue = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
        const secs = parseInt(headerValue, 10);
        if (isNaN(secs)) {
            return;
        }
        this.retryBackoff = Math.min(Math.max(secs, MIN_RETRY_BACKOFF_SECONDS), MAX_RETRY_BACKOFF_SECONDS);
        this.logger.warn(`Retry-After header: ${secs}s`);
    }
    scheduleNextProbe() {
        this.nextProbeAt = Date.now() + this.retryBackoff * 1000;
    }
    async onModuleDestroy() {
        clearInterval(this.rpmCleanupTimer);
        await this.pool.close();
    }
};
exports.SteamProxyService = SteamProxyService;
exports.SteamProxyService = SteamProxyService = SteamProxyService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [])
], SteamProxyService);


/***/ }),
/* 8 */
/***/ ((module) => {

module.exports = require("undici");

/***/ }),
/* 9 */
/***/ ((module) => {

module.exports = require("zlib");

/***/ }),
/* 10 */
/***/ ((module) => {

module.exports = require("buffer");

/***/ }),
/* 11 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.classifySteamFailure = classifySteamFailure;
exports.redactSteamPathForLog = redactSteamPathForLog;
function classifySteamFailure(statusCode, headers, bodyText) {
    const retryAfter = headers['retry-after'];
    const body = (bodyText || '').toLowerCase();
    if (statusCode === 429 || statusCode === 420 || statusCode === 503 || retryAfter) {
        return 'rate_limited';
    }
    if (/too many requests|rate.?limit|request limit|try again later/.test(body)) {
        return 'rate_limited';
    }
    if (statusCode === 401) {
        return 'bad_key';
    }
    if (statusCode === 403) {
        if (/access is denied|invalid.*(?:api.?)?key|(?:api.?)?key.*(?:invalid|denied|revoked|missing)|unauthorized/.test(body)) {
            return 'bad_key';
        }
        return 'rate_limited';
    }
    return null;
}
function redactSteamPathForLog(path) {
    return path.replace(/([?&]key=)[^&]*/gi, '$1***');
}


/***/ }),
/* 12 */
/***/ ((module) => {

module.exports = require("append-query");

/***/ }),
/* 13 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.getProxyBuildInfo = getProxyBuildInfo;
exports.proxyVersionHeaders = proxyVersionHeaders;
const fs_1 = __webpack_require__(14);
const path_1 = __webpack_require__(15);
let cached = null;
function readPackageVersion() {
    try {
        const pkgPath = (0, path_1.join)(process.cwd(), 'package.json');
        const pkg = JSON.parse((0, fs_1.readFileSync)(pkgPath, 'utf8'));
        return (pkg.version || '').trim() || 'unknown';
    }
    catch {
        return 'unknown';
    }
}
function optionalEnv(...keys) {
    for (const key of keys) {
        const v = (process.env[key] || '').trim();
        if (v)
            return v;
    }
    return null;
}
function getProxyBuildInfo() {
    if (cached)
        return cached;
    cached = {
        version: optionalEnv('APP_VERSION', 'npm_package_version') || readPackageVersion(),
        gitSha: optionalEnv('GIT_SHA', 'GITHUB_SHA', 'COMMIT_SHA'),
        imageTag: optionalEnv('IMAGE_TAG', 'STEAM_PROXY_IMAGE'),
    };
    return cached;
}
function proxyVersionHeaders() {
    const info = getProxyBuildInfo();
    const headers = {
        'X-Proxy-Version': info.version,
    };
    if (info.gitSha)
        headers['X-Git-Sha'] = info.gitSha;
    if (info.imageTag)
        headers['X-Image-Tag'] = info.imageTag;
    return headers;
}


/***/ }),
/* 14 */
/***/ ((module) => {

module.exports = require("fs");

/***/ }),
/* 15 */
/***/ ((module) => {

module.exports = require("path");

/***/ }),
/* 16 */
/***/ ((module) => {

module.exports = require("@nestjs/platform-fastify");

/***/ })
/******/ 	]);
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
// This entry needs to be wrapped in an IIFE because it needs to be isolated against other modules in the chunk.
(() => {
var exports = __webpack_exports__;

Object.defineProperty(exports, "__esModule", ({ value: true }));
const core_1 = __webpack_require__(1);
const app_module_1 = __webpack_require__(2);
const platform_fastify_1 = __webpack_require__(16);
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule, new platform_fastify_1.FastifyAdapter());
    const listenHost = process.env.LISTEN_HOST || '0.0.0.0';
    const listenPort = Number.parseInt(process.env.LISTEN_PORT || '8080', 10) || 8080;
    await app.listen(listenPort, listenHost);
}
bootstrap();

})();

/******/ })()
;