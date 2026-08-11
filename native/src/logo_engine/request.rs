//! Request nội bộ ổn định cho PrynX Logo Engine v2.

use sha2::{Digest, Sha256};

pub(crate) const LOGO_ENGINE_REQUEST_VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LogoEngineProfile {
    Silhouette,
    FlatColor,
}

impl LogoEngineProfile {
    pub(crate) fn from_legacy_mode(mode: &str) -> Result<Self, String> {
        match mode {
            "monochrome" => Ok(Self::Silhouette),
            "fixed_palette" => Ok(Self::FlatColor),
            _ => Err("Mode vector hóa logo không được hỗ trợ".to_string()),
        }
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Silhouette => "silhouette",
            Self::FlatColor => "flat_color",
        }
    }

    const fn hash_tag(self) -> u8 {
        match self {
            Self::Silhouette => 1,
            Self::FlatColor => 2,
        }
    }
}

#[derive(Debug)]
pub(crate) struct LogoEngineRequest {
    pub(crate) width: usize,
    pub(crate) height: usize,
    pub(crate) rgba: Vec<u8>,
    pub(crate) profile: LogoEngineProfile,
    pub(crate) palette: Vec<String>,
    pub(crate) smoothing: f64,
    pub(crate) despeckle_size_px: usize,
}

impl LogoEngineRequest {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_legacy_api(
        width: usize,
        height: usize,
        rgba: Vec<u8>,
        mode: &str,
        palette: Vec<String>,
        smoothing: f64,
        despeckle_size_px: usize,
    ) -> Result<Self, String> {
        Ok(Self {
            width,
            height,
            rgba,
            profile: LogoEngineProfile::from_legacy_mode(mode)?,
            palette,
            smoothing,
            despeckle_size_px,
        })
    }

    /// Hash cấu hình rẻ, không quét lại toàn bộ RGBA trong đường preview.
    /// Content hash sẽ do tầng artifact/cache bổ sung ở lô riêng.
    pub(crate) fn settings_hash(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(LOGO_ENGINE_REQUEST_VERSION.to_be_bytes());
        hasher.update((self.width as u64).to_be_bytes());
        hasher.update((self.height as u64).to_be_bytes());
        hasher.update([self.profile.hash_tag()]);
        hasher.update(self.smoothing.to_bits().to_be_bytes());
        hasher.update((self.despeckle_size_px as u64).to_be_bytes());
        hasher.update((self.palette.len() as u32).to_be_bytes());
        for color in &self.palette {
            hasher.update((color.len() as u32).to_be_bytes());
            hasher.update(color.as_bytes());
        }
        format!("{:x}", hasher.finalize())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(palette: Vec<String>) -> LogoEngineRequest {
        LogoEngineRequest::from_legacy_api(2, 2, vec![255; 16], "fixed_palette", palette, 0.0, 4)
            .unwrap()
    }

    #[test]
    fn legacy_modes_map_to_explicit_profiles() {
        assert_eq!(
            LogoEngineProfile::from_legacy_mode("monochrome").unwrap(),
            LogoEngineProfile::Silhouette
        );
        assert_eq!(
            LogoEngineProfile::from_legacy_mode("fixed_palette").unwrap(),
            LogoEngineProfile::FlatColor
        );
    }

    #[test]
    fn settings_hash_is_deterministic_and_order_sensitive() {
        let first = request(vec!["#ff0000".to_string(), "#ffffff".to_string()]);
        let same = request(vec!["#ff0000".to_string(), "#ffffff".to_string()]);
        let reordered = request(vec!["#ffffff".to_string(), "#ff0000".to_string()]);

        assert_eq!(first.settings_hash(), same.settings_hash());
        assert_ne!(first.settings_hash(), reordered.settings_hash());
        assert_eq!(first.settings_hash().len(), 64);
    }
}
