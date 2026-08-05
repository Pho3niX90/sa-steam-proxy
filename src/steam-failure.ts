/**
 * Steam historically does not use 429 reliably. Detect:
 * - 429, 420 (unofficial Steam throttle), or Retry-After → rate limited
 * - 503 (Steam: unavailable / too busy) → rate limited (backoff + probe)
 * - body rate-limit wording → rate limited
 * - 401 / explicit invalid-key wording on 403 → bad key
 * - bare / empty 403 → rate limited (Steam's common throttle; not a definitive bad key)
 */
export function classifySteamFailure(
  statusCode: number,
  headers: Record<string, string | string[] | undefined>,
  bodyText: string,
): 'rate_limited' | 'bad_key' | null {
  const retryAfter = headers['retry-after'];
  const body = (bodyText || '').toLowerCase();

  // 420 = unofficial "Enhance Your Calm"; Steam sometimes returns it under load.
  // 503 = documented "temporarily unavailable, or too busy".
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
    // Only latch bad_key when the body clearly blames the key.
    // Empty/generic 403 is Steam's usual IP/key throttle response.
    if (
      /access is denied|invalid.*(?:api.?)?key|(?:api.?)?key.*(?:invalid|denied|revoked|missing)|unauthorized/.test(
        body,
      )
    ) {
      return 'bad_key';
    }
    return 'rate_limited';
  }

  return null;
}

/** Strip Steam Web API keys from paths before writing to logs. */
export function redactSteamPathForLog(path: string): string {
  return path.replace(/([?&]key=)[^&]*/gi, '$1***');
}
