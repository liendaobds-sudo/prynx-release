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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LogoCurvePreset {
    Automatic,
    Faithful,
    Balanced,
    TrajectoryCompletion,
}

impl LogoCurvePreset {
    pub(crate) fn from_api(value: &str) -> Result<Self, String> {
        match value {
            "automatic" => Ok(Self::Automatic),
            "faithful" => Ok(Self::Faithful),
            "balanced" => Ok(Self::Balanced),
            "trajectory_completion" => Ok(Self::TrajectoryCompletion),
            _ => Err("Preset quỹ đạo logo không được hỗ trợ".to_string()),
        }
    }

    const fn hash_tag(self) -> u8 {
        match self {
            Self::Automatic => 1,
            Self::Faithful => 2,
            Self::Balanced => 3,
            Self::TrajectoryCompletion => 4,
        }
    }

    const fn smoothing(self) -> f64 {
        match self {
            Self::Automatic => 0.75,
            Self::Faithful => 0.2,
            Self::Balanced => 0.6,
            Self::TrajectoryCompletion => 1.0,
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
    pub(crate) curve_preset: Option<LogoCurvePreset>,
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
            curve_preset: None,
            despeckle_size_px,
        })
    }

    pub(crate) fn with_curve_preset(mut self, curve_preset: Option<&str>) -> Result<Self, String> {
        self.curve_preset = curve_preset.map(LogoCurvePreset::from_api).transpose()?;
        Ok(self)
    }

    pub(crate) fn effective_smoothing(&self) -> f64 {
        self.curve_preset
            .map(LogoCurvePreset::smoothing)
            .unwrap_or(self.smoothing)
    }
    /// Preset này thay đổi chiến lược dựng đường, không chỉ tăng tolerance.
    /// Fitter được phép nối lại toàn nhịp trơn bằng cubic nếu sai số hai chiều đạt.
    pub(crate) fn prefers_fair_curves(&self) -> bool {
        self.curve_preset == Some(LogoCurvePreset::TrajectoryCompletion)
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
        hasher.update([self
            .curve_preset
            .map(LogoCurvePreset::hash_tag)
            .unwrap_or(0)]);
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

    #[test]
    fn curve_preset_controls_smoothing_and_fair_curve_strategy() {
        let legacy = request(vec!["#ff0000".to_string()]);
        let automatic = request(vec!["#ff0000".to_string()])
            .with_curve_preset(Some("automatic"))
            .unwrap();
        let trajectory = request(vec!["#ff0000".to_string()])
            .with_curve_preset(Some("trajectory_completion"))
            .unwrap();

        assert_eq!(legacy.effective_smoothing(), 0.0);
        assert_eq!(automatic.effective_smoothing(), 0.75);
        assert_eq!(trajectory.effective_smoothing(), 1.0);
        assert!(!legacy.prefers_fair_curves());
        assert!(!automatic.prefers_fair_curves());
        assert!(trajectory.prefers_fair_curves());
        assert_ne!(legacy.settings_hash(), automatic.settings_hash());
        assert_ne!(automatic.settings_hash(), trajectory.settings_hash());
        assert!(legacy.with_curve_preset(Some("unknown")).is_err());
    }
}
