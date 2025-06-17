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
const steam_proxy_service_1 = __webpack_require__(8);
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
var _a, _b, _c, _d;
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.AppController = void 0;
const common_1 = __webpack_require__(3);
const schedule_1 = __webpack_require__(5);
const express_1 = __webpack_require__(6);
const fastify_1 = __webpack_require__(7);
const steam_proxy_service_1 = __webpack_require__(8);
let AppController = class AppController {
    constructor(steamProxy) {
        this.steamProxy = steamProxy;
    }
    getHealth(res) {
        const health = this.steamProxy.healthStatus;
        res
            .status(health.rateLimited ? 429 : 200)
            .headers({
            'X-RateLimit-Status': health.rateLimited ? 'limited' : 'ok',
            'X-Requests-Per-Minute': health.requestsPerMinute.toString(),
            'X-Backoff': health.backoff.toString(),
            'X-Retry-In': health.retryIn.toString(),
        })
            .send(health.rateLimited ? 'limit' : 'ok');
    }
    getMetrics() {
        return this.steamProxy.getMetrics();
    }
    async proxy(req, res) {
        const result = await this.steamProxy.proxy(req.originalUrl);
        if (result?.error) {
            res
                .status(result.error === 'rate_limited' ? 429 : 500)
                .header('X-RateLimit-Status', 'limited')
                .send(result.error);
        }
        else {
            res.status(200).send(result);
        }
    }
    checkRateLimit() {
        this.steamProxy.checkRateLimiting();
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
], AppController.prototype, "getHealth", null);
__decorate([
    (0, common_1.Get)('/metrics'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], AppController.prototype, "getMetrics", null);
__decorate([
    (0, common_1.Get)('/*'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [typeof (_c = typeof express_1.Request !== "undefined" && express_1.Request) === "function" ? _c : Object, typeof (_d = typeof fastify_1.FastifyReply !== "undefined" && fastify_1.FastifyReply) === "function" ? _d : Object]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "proxy", null);
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_5_MINUTES),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
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


/***/ }),
/* 5 */
/***/ ((module) => {

module.exports = require("@nestjs/schedule");

/***/ }),
/* 6 */
/***/ ((module) => {

module.exports = require("express");

/***/ }),
/* 7 */
/***/ ((module) => {

module.exports = require("fastify");

/***/ }),
/* 8 */
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
const undici_1 = __webpack_require__(9);
const append_query_1 = __webpack_require__(10);
const STEAM_API_HOST = 'http://api.steampowered.com';
const SAFE_PROBE_PATH = '/ISteamWebAPIUtil/GetServerInfo/v0001/';
const CACHE_TTL_MS = 10_000;
const ONE_MINUTE = 60_000;
let SteamProxyService = SteamProxyService_1 = class SteamProxyService {
    constructor() {
        this.logger = new common_1.Logger(SteamProxyService_1.name);
        this.cache = new Map();
        this.requestTimestamps = [];
        this.isRateLimited = false;
        this.lastFailurePath = '';
        this.retryCounter = 0;
        this.retryBackoff = 5;
        this.metrics = {
            total: 0,
            success: 0,
            failure: 0,
            lastDurationMs: 0,
        };
        this.pool = new undici_1.Pool(STEAM_API_HOST, {
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
    async proxy(originalPath) {
        this.cleanupOldRequests();
        this.requestTimestamps.push(Date.now());
        this.metrics.total++;
        const fullPath = (0, append_query_1.default)(originalPath);
        const cacheKey = fullPath;
        const now = Date.now();
        const cached = this.cache.get(cacheKey);
        if (cached && cached.expires > now && !this.isRateLimited) {
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
            const { statusCode, body } = result;
            const data = await body.json().catch(() => body.text());
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
        }
        catch (err) {
            this.metrics.failure++;
            this.metrics.lastDurationMs = Date.now() - start;
            this.logger.error(`Steam fetch error: ${err.message}`);
            return { error: 'nok' };
        }
    }
    async checkRateLimiting() {
        if (!this.isRateLimited)
            return;
        this.retryCounter++;
        if (this.retryCounter < this.retryBackoff)
            return;
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
                const secs = parseInt(retryAfter, 10);
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
            }
            else if (res.statusCode === 429) {
                this.retryBackoff *= 2;
                this.logger.warn(`Still rate-limited. Increasing backoff to ${this.retryBackoff}s.`);
            }
            else {
                this.logger.warn(`Unexpected probe status: ${res.statusCode}`);
            }
        }
        catch (err) {
            this.logger.error(`Rate-limit probe error: ${err.message}`);
        }
    }
    cleanupOldRequests() {
        const cutoff = Date.now() - ONE_MINUTE;
        this.requestTimestamps = this.requestTimestamps.filter(t => t > cutoff);
    }
    handleRateLimit(path) {
        this.metrics.failure++;
        this.lastFailurePath = path;
        if (!this.isRateLimited) {
            this.isRateLimited = true;
            this.rateLimitStart = Date.now();
        }
    }
};
exports.SteamProxyService = SteamProxyService;
exports.SteamProxyService = SteamProxyService = SteamProxyService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [])
], SteamProxyService);


/***/ }),
/* 9 */
/***/ ((module) => {

module.exports = require("undici");

/***/ }),
/* 10 */
/***/ ((module) => {

module.exports = require("append-query");

/***/ }),
/* 11 */
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
const platform_fastify_1 = __webpack_require__(11);
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule, new platform_fastify_1.FastifyAdapter());
    await app.listen(8080, '0.0.0.0');
}
bootstrap();

})();

/******/ })()
;