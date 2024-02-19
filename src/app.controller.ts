import { Controller, Get, Req, Res } from '@nestjs/common';
import { AppService } from './app.service';
import { Cron } from '@nestjs/schedule';

const apiUrl = 'http://api.steampowered.com';
let isHealthy = true;
let isRateLimited = false;
let lastFailureUrl = '';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const appendQuery = require('append-query');

const metrics = {
  total: 0,
  successTotal: 0,
  failuresTotal: 0,
};

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Cron('0 */1 * * * *')
  clearMetrics() {
    console.log(`running cron`);
    metrics.total = 0;
    metrics.successTotal = 0;
    metrics.failuresTotal = 0;
    this.checkRateLimiting();
  }

  @Get('/healthz')
  getHealth() {
    return isHealthy ? 'ok' : isRateLimited ? 'limit' : 'nok';
  }

  @Get('/*')
  async doProxy(@Req() request, @Res() response) {
    if (!isHealthy || isRateLimited) {
      response.headers({ 'rate-limited': isRateLimited });
      response.status(429);
      response.send('nok');
    } else {
      response.send(await this.doRequest(request.originalUrl, response));
    }
  }

  setStatus(s, t) {
    metrics.total++;
    if (s < 400) {
      isHealthy = true;
      t.headers({ 'rate-limited': isRateLimited });
      metrics.successTotal++;
    } else {
      isHealthy = false;
      if (s == 429) {
        isRateLimited = true;
        t.headers({ 'rate-limited': isRateLimited });
      } else {
        t.headers({ 'rate-limited': isRateLimited });
      }
      metrics.failuresTotal++;
    }

    t?.status(s);
  }

  async checkRateLimiting() {
    if (lastFailureUrl !== '')
      this.doRequest(lastFailureUrl).then((x) => {
        if (x !== 'nok') {
          isRateLimited = false;
          lastFailureUrl = '';
          console.log(`rate limiting ended`);
        } else {
          console.log(`still rate limited`);
        }
      });
  }

  async doRequest(url, reply?) {
    return await fetch(
      appendQuery(apiUrl + url /*, { key: this.checkKeyInHostname() }*/),
    )
      .then(async (value) => {
        if (reply) this.setStatus(value.status, reply);
        if (!value.ok) {
          lastFailureUrl = url;
          return 'nok';
        }
        try {
          return await value.json();
        } catch (e) {
          return await value.body;
        }
      })
      .catch((e) => {
        isHealthy = false;
        console.error(e.message);
        return 'nok';
      });
  }
}
