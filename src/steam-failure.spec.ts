import { classifySteamFailure, redactSteamPathForLog } from './steam-failure';

describe('classifySteamFailure', () => {
  it('treats 429 and Retry-After as rate_limited', () => {
    expect(classifySteamFailure(429, {}, '')).toBe('rate_limited');
    expect(classifySteamFailure(200, { 'retry-after': '30' }, '')).toBe('rate_limited');
  });

  it('treats unofficial Steam 420 as rate_limited', () => {
    expect(classifySteamFailure(420, {}, '')).toBe('rate_limited');
  });

  it('treats Steam 503 (too busy / unavailable) as rate_limited', () => {
    expect(classifySteamFailure(503, {}, '')).toBe('rate_limited');
  });

  it('treats rate-limit body text as rate_limited', () => {
    expect(classifySteamFailure(500, {}, 'Too Many Requests')).toBe('rate_limited');
  });

  it('treats 401 as bad_key', () => {
    expect(classifySteamFailure(401, {}, '')).toBe('bad_key');
  });

  it('treats empty-body 403 as rate_limited (Steam throttle)', () => {
    expect(classifySteamFailure(403, {}, '')).toBe('rate_limited');
    expect(classifySteamFailure(403, {}, 'Forbidden')).toBe('rate_limited');
  });

  it('treats explicit invalid-key 403 as bad_key', () => {
    expect(classifySteamFailure(403, {}, 'Access is denied')).toBe('bad_key');
    expect(classifySteamFailure(403, {}, 'Invalid API key')).toBe('bad_key');
    expect(classifySteamFailure(403, {}, 'API key revoked')).toBe('bad_key');
  });

  it('returns null for normal errors', () => {
    expect(classifySteamFailure(500, {}, 'oops')).toBeNull();
    expect(classifySteamFailure(200, {}, '')).toBeNull();
    expect(classifySteamFailure(400, {}, '')).toBeNull();
  });
});

describe('redactSteamPathForLog', () => {
  it('redacts key query params', () => {
    expect(
      redactSteamPathForLog(
        '/ISteamUser/GetPlayerBans/v1?steamids=1&key=CF41219DC80663076C89E9C6B91BFC1B',
      ),
    ).toBe('/ISteamUser/GetPlayerBans/v1?steamids=1&key=***');
  });

  it('redacts key when it is the first query param', () => {
    expect(redactSteamPathForLog('/IPlayerService/GetSteamLevel/v1?key=ABC123&steamid=1')).toBe(
      '/IPlayerService/GetSteamLevel/v1?key=***&steamid=1',
    );
  });

  it('leaves paths without a key unchanged', () => {
    expect(redactSteamPathForLog('/ISteamWebAPIUtil/GetServerInfo/v0001/')).toBe(
      '/ISteamWebAPIUtil/GetServerInfo/v0001/',
    );
  });
});
