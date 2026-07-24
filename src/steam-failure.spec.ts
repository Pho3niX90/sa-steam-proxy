import { classifySteamFailure } from './steam-failure';

describe('classifySteamFailure', () => {
  it('treats 429 and Retry-After as rate_limited', () => {
    expect(classifySteamFailure(429, {}, '')).toBe('rate_limited');
    expect(classifySteamFailure(200, { 'retry-after': '30' }, '')).toBe('rate_limited');
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
  });
});
