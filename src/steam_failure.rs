use regex::Regex;
use std::borrow::Cow;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SteamFailure {
    RateLimited,
    BadKey,
}

fn rate_limit_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)too many requests|rate.?limit|request limit|try again later").expect("valid rate limit regex")
    })
}

fn bad_key_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)access is denied|verify your\s*(?:<[^>]+>\s*)?key=|invalid.*(?:api.?)?key|(?:api.?)?key.*(?:invalid|denied|revoked|missing)|unauthorized",
        )
        .expect("valid bad key regex")
    })
}

/// Strict key-blame matcher used for HTTP 401 responses. Steam returns HTTP 401
/// with `{}` / empty body / generic "Unauthorized" for private profiles and
/// friend lists, whereas genuine key errors explicitly blame the `key=` param.
fn explicit_bad_key_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)access is denied|verify your\s*(?:<[^>]+>\s*)?key=|invalid.*(?:api.?)?key|(?:api.?)?key.*(?:invalid|denied|revoked|missing)",
        )
        .expect("valid explicit bad key regex")
    })
}

fn redact_path_key_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)([?&]key=)[^&]*").expect("valid redact path regex"))
}

fn redact_text_key_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)([?&]key=)[^&\s)"']*"#).expect("valid redact text regex"))
}

/// Returns true for Steam Web API endpoints where HTTP 401 is the normal
/// response for a private profile or private friend list rather than a bad key.
pub fn is_privacy_restricted_endpoint(path: &str) -> bool {
    let path_only = path.split('?').next().unwrap_or("").to_ascii_lowercase();
    let trimmed = path_only.trim_start_matches('/');
    trimmed.starts_with("isteamuser/getfriendlist")
        || trimmed.starts_with("isteamuser/getusergrouplist")
        || trimmed.starts_with("iplayerservice/getownedgames")
        || trimmed.starts_with("iplayerservice/getrecentlyplayedgames")
        || trimmed.starts_with("iplayerservice/getsteamlevel")
        || trimmed.starts_with("iplayerservice/getbadges")
        || trimmed.starts_with("isteamuserstats/getuserstatsforgame")
        || trimmed.starts_with("isteamuserstats/getplayerachievements")
}

/// Extract the `key=` query parameter value (case-insensitive) from a request path.
pub fn extract_key_param(path: &str) -> Option<String> {
    let query = path.split_once('?')?.1;
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k.eq_ignore_ascii_case("key") && !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Strip the `key=` query parameter from a path to produce a key-agnostic cache key.
pub fn canonical_cache_key(path: &str) -> String {
    let normalized = if path.starts_with('/') {
        Cow::Borrowed(path)
    } else {
        Cow::Owned(format!("/{path}"))
    };
    let Some((base, query)) = normalized.split_once('?') else {
        return normalized.into_owned();
    };
    let kept: Vec<&str> = query
        .split('&')
        .filter(|pair| !pair.is_empty() && !pair.split_once('=').is_some_and(|(k, _)| k.eq_ignore_ascii_case("key")))
        .collect();
    if kept.is_empty() {
        base.to_string()
    } else {
        format!("{base}?{}", kept.join("&"))
    }
}

/// Steam historically does not use 429 reliably. Detect:
/// - 429, 420 (unofficial Steam throttle), or Retry-After → RateLimited
/// - 503 (Steam: unavailable / too busy) → RateLimited (backoff + probe)
/// - body rate-limit wording → RateLimited
/// - 401 with explicit invalid-key wording → BadKey (bare 401 / `{}` is Steam's private profile response)
/// - 403 with explicit invalid-key wording → BadKey
/// - bare / empty 403 → RateLimited (Steam's common throttle; not a definitive bad key)
pub fn classify_steam_failure(status_code: u16, retry_after: Option<&str>, body_text: &str) -> Option<SteamFailure> {
    let has_retry_after = retry_after.is_some_and(|v| !v.is_empty());

    if matches!(status_code, 429 | 420 | 503) || has_retry_after {
        return Some(SteamFailure::RateLimited);
    }
    if rate_limit_re().is_match(body_text) {
        return Some(SteamFailure::RateLimited);
    }

    if status_code == 401 {
        // Steam returns HTTP 401 (with `{}` or empty body) for private friend lists / profiles.
        // Only treat 401 as BadKey when the response body explicitly blames the API key.
        if explicit_bad_key_re().is_match(body_text) {
            return Some(SteamFailure::BadKey);
        }
        return None;
    }
    if status_code == 403 {
        if bad_key_re().is_match(body_text) {
            return Some(SteamFailure::BadKey);
        }
        return Some(SteamFailure::RateLimited);
    }

    None
}

/// Strip Steam Web API keys from paths before writing to logs.
pub fn redact_steam_path_for_log(path: &str) -> Cow<'_, str> {
    redact_path_key_re().replace_all(path, "${1}***")
}

/// Strip Steam Web API keys from arbitrary log/error text (such as reqwest URL errors).
pub fn redact_keys_in_text(text: &str) -> Cow<'_, str> {
    redact_text_key_re().replace_all(text, "${1}***")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn treats_429_and_retry_after_as_rate_limited() {
        assert_eq!(classify_steam_failure(429, None, ""), Some(SteamFailure::RateLimited));
        assert_eq!(
            classify_steam_failure(200, Some("30"), ""),
            Some(SteamFailure::RateLimited)
        );
    }

    #[test]
    fn treats_unofficial_steam_420_as_rate_limited() {
        assert_eq!(classify_steam_failure(420, None, ""), Some(SteamFailure::RateLimited));
    }

    #[test]
    fn treats_steam_503_as_rate_limited() {
        assert_eq!(classify_steam_failure(503, None, ""), Some(SteamFailure::RateLimited));
    }

    #[test]
    fn treats_rate_limit_body_text_as_rate_limited() {
        assert_eq!(
            classify_steam_failure(500, None, "Too Many Requests"),
            Some(SteamFailure::RateLimited)
        );
        assert_eq!(
            classify_steam_failure(500, None, "Rate-Limit exceeded"),
            Some(SteamFailure::RateLimited)
        );
        assert_eq!(
            classify_steam_failure(500, None, "Request limit reached"),
            Some(SteamFailure::RateLimited)
        );
        assert_eq!(
            classify_steam_failure(500, None, "Please try again later"),
            Some(SteamFailure::RateLimited)
        );
    }

    #[test]
    fn treats_bare_or_private_401_as_non_key_error() {
        assert_eq!(classify_steam_failure(401, None, ""), None);
        assert_eq!(classify_steam_failure(401, None, "{}"), None);
        assert_eq!(classify_steam_failure(401, None, "Unauthorized"), None);
    }

    #[test]
    fn treats_explicit_key_blame_401_as_bad_key() {
        assert_eq!(
            classify_steam_failure(
                401,
                None,
                "Access is denied. Please verify your <pre>key=</pre> parameter."
            ),
            Some(SteamFailure::BadKey)
        );
        assert_eq!(
            classify_steam_failure(401, None, "Invalid API key"),
            Some(SteamFailure::BadKey)
        );
    }

    #[test]
    fn identifies_privacy_restricted_endpoints() {
        assert!(is_privacy_restricted_endpoint(
            "/ISteamUser/GetFriendList/v0001?steamid=76561199122695345&relationship=friend&key=ABC"
        ));
        assert!(is_privacy_restricted_endpoint(
            "/IPlayerService/GetSteamLevel/v1?steamid=1"
        ));
        assert!(!is_privacy_restricted_endpoint(
            "/ISteamUser/GetPlayerSummaries/v0002?steamids=1"
        ));
    }

    #[test]
    fn extracts_key_and_canonicalizes_cache_key() {
        assert_eq!(
            extract_key_param("/ISteamUser/GetPlayerSummaries/v0002?steamids=1&key=SECRET123"),
            Some("SECRET123".to_string())
        );
        assert_eq!(
            extract_key_param("/ISteamUser/GetPlayerSummaries/v0002?KEY=ABC&steamids=1"),
            Some("ABC".to_string())
        );
        assert_eq!(
            extract_key_param("/ISteamUser/GetPlayerSummaries/v0002?steamids=1"),
            None
        );
        assert_eq!(extract_key_param("/test?key="), None);

        assert_eq!(
            canonical_cache_key("/ISteamUser/GetPlayerSummaries/v0002?steamids=1&key=SECRET123"),
            "/ISteamUser/GetPlayerSummaries/v0002?steamids=1"
        );
        assert_eq!(
            canonical_cache_key("/ISteamUser/GetPlayerSummaries/v0002?KEY=ABC&steamids=1"),
            "/ISteamUser/GetPlayerSummaries/v0002?steamids=1"
        );
        assert_eq!(canonical_cache_key("/item?key=ABC"), "/item");
        assert_eq!(canonical_cache_key("item?id=1"), "/item?id=1");
    }

    #[test]
    fn treats_empty_or_generic_403_as_rate_limited() {
        assert_eq!(classify_steam_failure(403, None, ""), Some(SteamFailure::RateLimited));
        assert_eq!(
            classify_steam_failure(403, None, "Forbidden"),
            Some(SteamFailure::RateLimited)
        );
    }

    #[test]
    fn treats_explicit_invalid_key_403_as_bad_key() {
        assert_eq!(
            classify_steam_failure(403, None, "Access is denied"),
            Some(SteamFailure::BadKey)
        );
        assert_eq!(
            classify_steam_failure(403, None, "Invalid API key"),
            Some(SteamFailure::BadKey)
        );
        assert_eq!(
            classify_steam_failure(403, None, "API key revoked"),
            Some(SteamFailure::BadKey)
        );
        assert_eq!(
            classify_steam_failure(
                403,
                None,
                "<html><body><h1>403 Forbidden</h1>Unauthorized</body></html>"
            ),
            Some(SteamFailure::BadKey)
        );
        assert_eq!(
            classify_steam_failure(403, None, "Key missing"),
            Some(SteamFailure::BadKey)
        );
    }

    #[test]
    fn returns_none_for_normal_errors() {
        assert_eq!(classify_steam_failure(500, None, "oops"), None);
        assert_eq!(classify_steam_failure(200, None, ""), None);
        assert_eq!(classify_steam_failure(400, None, ""), None);
        assert_eq!(classify_steam_failure(404, None, "Not Found"), None);
    }

    #[test]
    fn redacts_key_query_params() {
        assert_eq!(
            redact_steam_path_for_log("/ISteamUser/GetPlayerBans/v1?steamids=1&key=CF41219DC80663076C89E9C6B91BFC1B"),
            "/ISteamUser/GetPlayerBans/v1?steamids=1&key=***"
        );
    }

    #[test]
    fn redacts_key_when_first_query_param() {
        assert_eq!(
            redact_steam_path_for_log("/IPlayerService/GetSteamLevel/v1?key=ABC123&steamid=1"),
            "/IPlayerService/GetSteamLevel/v1?key=***&steamid=1"
        );
    }

    #[test]
    fn redacts_key_case_insensitively() {
        assert_eq!(
            redact_steam_path_for_log("/ISteamUser/GetPlayerSummaries/v2/?KEY=SECRET999&steamids=1"),
            "/ISteamUser/GetPlayerSummaries/v2/?KEY=***&steamids=1"
        );
    }

    #[test]
    fn leaves_paths_without_key_unchanged() {
        assert_eq!(
            redact_steam_path_for_log("/ISteamWebAPIUtil/GetServerInfo/v0001/"),
            "/ISteamWebAPIUtil/GetServerInfo/v0001/"
        );
    }

    #[test]
    fn redacts_keys_in_error_text() {
        assert_eq!(
            redact_keys_in_text("error sending request for url (http://api.steampowered.com/test?key=SECRET123&id=1)"),
            "error sending request for url (http://api.steampowered.com/test?key=***&id=1)"
        );
    }
}
