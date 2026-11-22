use http::header::{HeaderMap, HeaderName, HeaderValue};
use serde::Serialize;

pub static HEADER_PROXY_VERSION: HeaderName = HeaderName::from_static("x-proxy-version");
pub static HEADER_GIT_SHA: HeaderName = HeaderName::from_static("x-git-sha");
pub static HEADER_IMAGE_TAG: HeaderName = HeaderName::from_static("x-image-tag");

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyBuildInfo {
    /// Semver from APP_VERSION env, npm_package_version, or Cargo.toml
    pub version: String,
    /// Optional git commit / build id
    pub git_sha: Option<String>,
    /// Image ref or tag when set by the orchestrator
    pub image_tag: Option<String>,
}

impl Default for ProxyBuildInfo {
    fn default() -> Self {
        Self {
            version: env!("CARGO_PKG_VERSION").to_string(),
            git_sha: None,
            image_tag: None,
        }
    }
}

impl ProxyBuildInfo {
    pub fn from_env() -> Self {
        let version = optional_env(&["APP_VERSION", "npm_package_version"])
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
        let git_sha = optional_env(&["GIT_SHA", "GITHUB_SHA", "COMMIT_SHA"]);
        let image_tag = optional_env(&["IMAGE_TAG", "STEAM_PROXY_IMAGE"]);
        Self {
            version,
            git_sha,
            image_tag,
        }
    }

    pub fn apply_headers(&self, headers: &mut HeaderMap) {
        if let Ok(val) = HeaderValue::from_str(&self.version) {
            headers.insert(HEADER_PROXY_VERSION.clone(), val);
        }
        if let Some(ref sha) = self.git_sha {
            if let Ok(val) = HeaderValue::from_str(sha) {
                headers.insert(HEADER_GIT_SHA.clone(), val);
            }
        }
        if let Some(ref tag) = self.image_tag {
            if let Ok(val) = HeaderValue::from_str(tag) {
                headers.insert(HEADER_IMAGE_TAG.clone(), val);
            }
        }
    }
}

fn optional_env(keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Ok(val) = std::env::var(key) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}
