import { Controller, Get, Req, Res } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FastifyReply, FastifyRequest } from 'fastify';
import { SteamProxyService } from './steam-proxy.service';
import { getProxyBuildInfo, proxyVersionHeaders } from './version';

const RESERVED_PATHS = new Set(['/healthz', '/ready', '/metrics']);

@Controller()
export class AppController {
  constructor(private readonly steamProxy: SteamProxyService) {}

  /**
   * Liveness: process is up. Always 200 when the HTTP server answers.
   * Do not put Steam/key/rate-limit state here — that belongs on /ready.
   */
  @Get('/healthz')
  getLiveness(@Res() res: FastifyReply) {
    this.sendLiveness(res);
  }

  /**
   * Readiness: able to usefully proxy Steam traffic.
   * 200 + body "ok" when ready; 503 + reason (rate_limited | bad_key) when not.
   * Always includes X-Proxy-Version (+ optional X-Git-Sha / X-Image-Tag).
   */
  @Get('/ready')
  getReady(@Res() res: FastifyReply) {
    this.sendReady(res);
  }

  @Get('/metrics')
  getMetrics(@Res() res: FastifyReply) {
    res
      .status(200)
      .headers(proxyVersionHeaders())
      .send({
        ...this.steamProxy.getMetrics(),
        build: getProxyBuildInfo(),
      });
  }

  /**
   * Catch-all Steam proxy. Fastify can let `/*` steal `/ready` etc., so reserved
   * paths are handled here as well and never forwarded upstream.
   */
  @Get('/*')
  async proxy(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
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
        .headers(proxyVersionHeaders())
        .send({
          ...this.steamProxy.getMetrics(),
          build: getProxyBuildInfo(),
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
        .status(
          result.statusCode ||
            (result.error === 'rate_limited' ? 429 : result.error === 'bad_key' ? 403 : 500),
        )
        .header('X-RateLimit-Status', result.error === 'rate_limited' ? 'limited' : 'ok')
        .header('X-Bad-Key', result.error === 'bad_key' ? 'true' : 'false')
        .header('X-Status-Message', result.error)
        .send(result.error);
    } else {
      res.status(result.statusCode || 200).send(result.data);
    }
  }

  private sendLiveness(res: FastifyReply) {
    const live = this.steamProxy.livenessStatus;
    res
      .status(200)
      .headers({
        ...proxyVersionHeaders(),
        'X-Alive': 'true',
        'X-Requests-Per-Minute': live.requestsPerMinute.toString(),
      })
      .send('ok');
  }

  private sendReady(res: FastifyReply) {
    const ready = this.steamProxy.readyStatus;
    const body = ready.ready ? 'ok' : ready.status;
    res
      .status(ready.ready ? 200 : 503)
      .headers({
        ...proxyVersionHeaders(),
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

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkRateLimit() {
    await this.steamProxy.checkRateLimiting();
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  restart() {
    console.log('[CRON] Midnight restart');
    process.exit();
  }
}

function pathnameOf(req: FastifyRequest): string {
  const raw = req.url || '/';
  const q = raw.indexOf('?');
  return q === -1 ? raw : raw.slice(0, q);
}
