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
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [schedule_1.ScheduleModule.forRoot()],
        controllers: [app_controller_1.AppController],
        providers: []
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
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.AppController = void 0;
const common_1 = __webpack_require__(3);
const schedule_1 = __webpack_require__(5);
const apiUrl = 'http://api.steampowered.com';
let isHealthy = true;
let isRateLimited = false;
let lastFailureUrl = '';
const appendQuery = __webpack_require__(6);
let AppController = class AppController {
    constructor() {
        this.rollingWindow = [];
        this.requestsPerSecond = 0;
        this.rateLimitCounter = 0;
        this.rateLimitNextCounter = 5;
        this.metrics = {
            total: 0,
            successTotal: 0,
            failuresTotal: 0
        };
    }
    cronClearMetrics() {
        console.debug(`running cron`);
        this.metrics.total = 0;
        this.metrics.successTotal = 0;
        this.metrics.failuresTotal = 0;
    }
    cronCheckRateLimiting() {
        this.checkRateLimiting();
    }
    getHealth() {
        if (isRateLimited || this.requestsPerSecond > 100) {
            return 'limit';
        }
        return isHealthy ? 'ok' : 'nok';
    }
    getMetrics() {
        return { ...this.metrics };
    }
    async doProxy(request, response) {
        this.rollingWindow = this.rollingWindow.filter((timestamp) => Date.now() - timestamp < 60000);
        this.rollingWindow.push(Date.now());
        this.requestsPerSecond = this.rollingWindow.length;
        if (isRateLimited) {
            response.headers({ 'rate-limited': isRateLimited });
            response.status(isRateLimited ? 429 : 500);
            response.send('nok');
            console.log(isRateLimited ? 429 : 500, this.requestsPerSecond, `URL (rejected) ${request.originalUrl}`);
        }
        else {
            response.send(await this.doRequest(request.originalUrl, response));
        }
    }
    setStatus(s, t) {
        this.metrics.total++;
        if (s < 400) {
            isHealthy = true;
            t.headers({ 'rate-limited': isRateLimited });
            this.metrics.successTotal++;
        }
        else {
            isHealthy = false;
            if (s == 429) {
                isRateLimited = true;
                t.headers({ 'rate-limited': isRateLimited });
            }
            else {
                t.headers({ 'rate-limited': isRateLimited });
                setTimeout(() => {
                    isHealthy = true;
                }, 10000);
            }
            this.metrics.failuresTotal++;
        }
        t?.status(s);
    }
    async checkRateLimiting() {
        if (lastFailureUrl === '') {
            return;
        }
        this.rateLimitCounter++;
        if (this.rateLimitCounter < this.rateLimitNextCounter) {
            return;
        }
        this.rateLimitCounter = 0;
        this.doRequest(lastFailureUrl).then((x) => {
            if (x !== 'nok') {
                isRateLimited = false;
                lastFailureUrl = '';
                console.log(`rate limiting ended`);
                this.rateLimitNextCounter = 5;
                this.rateLimitCounter = 0;
            }
            else {
                console.log(`still rate limited`);
                this.rateLimitNextCounter = Math.round(this.rateLimitNextCounter * 2);
            }
        });
    }
    async doRequest(url, reply) {
        return await fetch(appendQuery(apiUrl + url))
            .then(async (value) => {
            if (reply)
                this.setStatus(value.status, reply);
            console.log(value.status, this.requestsPerSecond, `URL (accepted) ${url}`);
            if (!value.ok) {
                lastFailureUrl = url;
                return 'nok';
            }
            try {
                return await value.json();
            }
            catch (e) {
                return await value.body;
            }
        })
            .catch((e) => {
            isHealthy = false;
            console.error(e.message);
            return 'nok';
        });
    }
};
exports.AppController = AppController;
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_DAY_AT_MIDNIGHT),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], AppController.prototype, "cronClearMetrics", null);
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_5_MINUTES),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], AppController.prototype, "cronCheckRateLimiting", null);
__decorate([
    (0, common_1.Get)('/healthz'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
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
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "doProxy", null);
exports.AppController = AppController = __decorate([
    (0, common_1.Controller)(),
    __metadata("design:paramtypes", [])
], AppController);


/***/ }),
/* 5 */
/***/ ((module) => {

module.exports = require("@nestjs/schedule");

/***/ }),
/* 6 */
/***/ ((module) => {

module.exports = require("append-query");

/***/ }),
/* 7 */
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
// This entry need to be wrapped in an IIFE because it need to be isolated against other modules in the chunk.
(() => {
var exports = __webpack_exports__;

Object.defineProperty(exports, "__esModule", ({ value: true }));
const core_1 = __webpack_require__(1);
const app_module_1 = __webpack_require__(2);
const platform_fastify_1 = __webpack_require__(7);
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule, new platform_fastify_1.FastifyAdapter());
    await app.listen(8080, '0.0.0.0');
}
bootstrap();

})();

/******/ })()
;