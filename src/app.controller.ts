import { Controller, Get, Req, Res } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

const apiUrl = 'http://api.steampowered.com';
let isHealthy = true;
let isRateLimited = false;
let lastFailureUrl = '';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const appendQuery = require('append-query');

@Controller()
export class AppController {
  private rollingWindow: number[] = [];
  private requestsPerMinute = 0;
  private rateLimitCounter = 0;
  private rateLimitNextCounter = 5;
  metrics = {
    total: 0,
    successTotal: 0,
    failuresTotal: 0
  };

  constructor() {
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  cronClearMetrics() {
    console.debug(`CRON: Midnight`);
    this.metrics.total = 0;
    this.metrics.successTotal = 0;
    this.metrics.failuresTotal = 0;
    try {
      process.exit()
    } catch (e) {
      
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  cronCheckRateLimiting() {
    console.debug(`CRON: Rate Limit Checking`);
    this.checkRateLimiting();
  }

  @Get('/healthz')
  getHealth() {
    if (isRateLimited || this.requestsPerMinute > 100) {
      return 'limit';
    }
    return isHealthy ? 'ok' : 'nok';
  }

  @Get('/metrics')
  getMetrics() {
    return { ...this.metrics };
  }

  @Get('/*')
  async doProxy(@Req() request, @Res() response) {
    // Remove entries older than 1 minute from the rolling window
    this.rollingWindow = this.rollingWindow.filter(
      (timestamp) => Date.now() - timestamp < 60000
    );

    // Add the current timestamp to the rolling window
    this.rollingWindow.push(Date.now());
    this.requestsPerMinute = this.rollingWindow.length;
    if (isRateLimited) {
      response.headers({ 'rate-limited': isRateLimited });
      response.status(isRateLimited ? 429 : 500);
      response.send('nok');
      console.log(
        isRateLimited ? 429 : 500,
        this.requestsPerMinute,
        `URL (rejected) ${request.originalUrl}`
      );
    } else {
      response.send(await this.doRequest(request.originalUrl, response));
    }
  }

  setStatus(s, t) {
    this.metrics.total++;
    if (s < 400) {
      isHealthy = true;
      t.headers({ 'rate-limited': isRateLimited });
      this.metrics.successTotal++;
    } else {
      isHealthy = false;
      if (s == 429) {
        isRateLimited = true;
        t.headers({ 'rate-limited': isRateLimited });
      } else {
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
    if(!isRateLimited) {
      console.log(`not rate limited.`)
      return;
    }
    if (lastFailureUrl === '') {
      console.log(`not rate limited.`)
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
      } else {
        console.log(`still rate limited`);
        this.rateLimitNextCounter = Math.round(this.rateLimitNextCounter * 2);
      }
    });
  }

  async doRequest(url, reply?) {
    return await fetch(
      appendQuery(apiUrl + url /*, { key: this.checkKeyInHostname() }*/)
    )
      .then(async (value) => {
        if (reply) this.setStatus(value.status, reply);
        console.log(
          value.status,
          this.requestsPerMinute,
          `URL (accepted) ${url}`
        );
        if (!value.ok) {
          lastFailureUrl = url;
          return 'nok';
        }
        try {
          return await value.json();
        } catch (e) {
          return value.body;
        }
      })
      .catch((e) => {
        isHealthy = false;
        console.error(e.message);
        return 'nok';
      });
  }
}
