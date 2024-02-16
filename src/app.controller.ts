import { Controller, Get, Req, Res } from '@nestjs/common';
import { AppService } from './app.service';
import { Cron } from '@nestjs/schedule';

const apiUrl = 'http://api.steampowered.com';
let isHealthy = true;
let isRateLimited = false;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const appendQuery = require('append-query');

const metrics = {
  total: 0,
  successTotal: 0,
  failuresTotal: 0
};

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {
  }

  @Cron('0 */1 * * * *')
  clearMetrics() {
    metrics.total = 0;
    metrics.successTotal = 0;
    metrics.failuresTotal = 0;
  }

  @Get('/healthz')
  getHealth() {
    return isHealthy ? 'ok' : isRateLimited ? 'limit' : 'nok';
  }

  @Get('/*')
  async doProxy(@Req() request, @Res() response) {
    response.send(await this.doRequest(request.originalUrl, response));
  }

  setStatus(s, t) {
    metrics.total++;
    if (s < 400) {
      isHealthy = true;
      isRateLimited = false;
      t.headers({ 'rate-limited': false });
      metrics.successTotal++;
    } else {
      isHealthy = false;
      if (s == 429) {
        t.headers({ 'rate-limited': true });
        isRateLimited = true;
      } else {
        t.headers({ 'rate-limited': false });
      }
      metrics.failuresTotal++;
    }

    t?.status(s);
  }

  async doRequest(url, reply) {
    return await fetch(
      appendQuery(apiUrl + url /*, { key: this.checkKeyInHostname() }*/)
    )
      .then(async (value) => {
        this.setStatus(value.status, reply);
        console.log(value.status, appendQuery(apiUrl + url));
        if (!value.ok) return;
        try {
          return await value.json();
        } catch (e) {
          return await value.body;
        }
      })
      .catch((e) => {
        isHealthy = false;
        console.error(e.message);
        return '';
      });
  }
}
