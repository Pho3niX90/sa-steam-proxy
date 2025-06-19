import { Controller, Get, Req, Res } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Request } from 'express';
import { FastifyReply } from 'fastify';
import { SteamProxyService } from './steam-proxy.service';

@Controller()
export class AppController {
  constructor(private readonly steamProxy: SteamProxyService) {}

  @Get('/healthz')
  getHealth(@Res() res: FastifyReply) {
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

  @Get('/metrics')
  getMetrics() {
    return this.steamProxy.getMetrics();
  }

  @Get('/*')
  async proxy(@Req() req: Request, @Res() res: FastifyReply) {
    const result = await this.steamProxy.proxy(req.originalUrl);
    if (result?.error) {
      res
        .status(result.error === 'rate_limited' ? 429 : 500)
        .header('X-RateLimit-Status', 'limited')
        .header('X-Status-Message', result.error)
        .send(result.error);
    } else {
      res.status(200).send(result);
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  checkRateLimit() {
    this.steamProxy.checkRateLimiting();
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  restart() {
    console.log('[CRON] Midnight restart');
    process.exit();
  }
}