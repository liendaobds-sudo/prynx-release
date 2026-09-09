//! SEC (audit 2026-09-09 §SEC.LICUX.RENEW): điều phối lịch xác minh giữa các
//! cửa sổ trong một process. Scheduler không cấp quyền; commit riêng ràng owner
//! với validator và persistence native, không thay thế chữ ký/proof/clock anchor.

use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{command, WebviewWindow};

const ATTEMPT_TTL: Duration = Duration::from_secs(120);
const COMPLETED_COOLDOWN: Duration = Duration::from_secs(10 * 60);
const RATE_LIMIT_COOLDOWN: Duration = Duration::from_secs(5 * 60);
const FAILED_COOLDOWN: Duration = Duration::from_secs(30);
const MAX_TRANSIENT_COOLDOWN: Duration = Duration::from_secs(10 * 60);

static RENEWAL_CLOCK: LazyLock<Instant> = LazyLock::new(Instant::now);
static RENEWAL_STATE: LazyLock<Mutex<RenewalState>> =
    LazyLock::new(|| Mutex::new(RenewalState::default()));

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RenewalStatus {
    Started,
    Busy,
    Cooldown,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BeginRenewalResult {
    pub status: RenewalStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    pub retry_after_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RenewalOutcome {
    Completed,
    RateLimited,
    Transient,
    Failed,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FinishRenewalResult {
    pub retry_after_ms: u64,
}

#[derive(Debug)]
struct ActiveAttempt {
    id: String,
    owner: String,
    started_at: Duration,
    expires_at: Duration,
}

#[derive(Debug)]
struct RenewalRecord {
    key_hash: [u8; 32],
    active: Option<ActiveAttempt>,
    not_before: Duration,
    transient_failures: u32,
}

#[derive(Debug, Default)]
struct RenewalState {
    epoch: Option<u64>,
    // Một record duy nhất: thay key không để lại map tăng mãi theo input renderer.
    record: Option<RenewalRecord>,
}

fn retry_after_ms(deadline: Duration, now: Duration) -> u64 {
    // Làm tròn lên để phần lẻ dưới 1ms không biến cooldown còn hiệu lực thành 0.
    let remaining_ms = deadline.saturating_sub(now).as_nanos().div_ceil(1_000_000);
    u64::try_from(remaining_ms).unwrap_or(u64::MAX)
}

fn license_key_hash(license_key: &str) -> Result<[u8; 32], String> {
    let normalized = license_key.trim().to_uppercase();
    if normalized.is_empty() || normalized.len() > 256 {
        return Err("License key không hợp lệ để điều phối xác minh".to_string());
    }
    Ok(Sha256::digest(normalized.as_bytes()).into())
}

impl RenewalState {
    fn begin(
        &mut self,
        epoch: u64,
        owner: &str,
        key_hash: [u8; 32],
        now: Duration,
        attempt_id: String,
    ) -> BeginRenewalResult {
        if self.epoch != Some(epoch) {
            self.epoch = Some(epoch);
            self.record = None;
        }

        if let Some(record) = self.record.as_mut() {
            if let Some(active) = record.active.as_ref() {
                if now < active.expires_at {
                    return BeginRenewalResult {
                        status: RenewalStatus::Busy,
                        attempt_id: None,
                        retry_after_ms: retry_after_ms(active.expires_at, now),
                    };
                }
                // Timeout chỉ hết quyền sở hữu scheduler, không hủy HTTP đã gửi.
                // Token trả muộn vẫn phải qua các guard native/epoch hiện hành.
                record.not_before = active.expires_at.saturating_add(FAILED_COOLDOWN);
                record.active = None;
                record.transient_failures = 0;
            }
            if record.key_hash == key_hash && now < record.not_before {
                return BeginRenewalResult {
                    status: RenewalStatus::Cooldown,
                    attempt_id: None,
                    retry_after_ms: retry_after_ms(record.not_before, now),
                };
            }
        }

        if self
            .record
            .as_ref()
            .is_none_or(|record| record.key_hash != key_hash)
        {
            self.record = Some(RenewalRecord {
                key_hash,
                active: None,
                not_before: Duration::ZERO,
                transient_failures: 0,
            });
        }
        if let Some(record) = self.record.as_mut() {
            record.active = Some(ActiveAttempt {
                id: attempt_id.clone(),
                owner: owner.to_string(),
                started_at: now,
                expires_at: now.saturating_add(ATTEMPT_TTL),
            });
        }
        BeginRenewalResult {
            status: RenewalStatus::Started,
            attempt_id: Some(attempt_id),
            retry_after_ms: 0,
        }
    }

    #[cfg(test)]
    fn finish(
        &mut self,
        epoch: u64,
        owner: &str,
        attempt_id: &str,
        outcome: RenewalOutcome,
        now: Duration,
    ) -> Result<FinishRenewalResult, String> {
        self.finish_with_retry(epoch, owner, attempt_id, outcome, now, None)
    }

    fn finish_with_retry(
        &mut self,
        epoch: u64,
        owner: &str,
        attempt_id: &str,
        outcome: RenewalOutcome,
        now: Duration,
        retry_after_seconds: Option<u64>,
    ) -> Result<FinishRenewalResult, String> {
        let retry = bounded_rate_limit_retry(outcome, retry_after_seconds)?;
        // Lượt stale/wrong-owner/replay không được sửa record, kể cả cooldown.
        if self.epoch != Some(epoch) {
            return Err("Lượt xác minh thuộc phiên bản quyền cũ".to_string());
        }
        let record = self
            .record
            .as_mut()
            .ok_or_else(|| "Không có lượt xác minh đang chờ".to_string())?;
        let active = record
            .active
            .as_ref()
            .ok_or_else(|| "Lượt xác minh đã kết thúc".to_string())?;
        if active.owner != owner || active.id != attempt_id {
            return Err("Lượt xác minh không thuộc cửa sổ hiện tại".to_string());
        }
        if now < active.started_at || now >= active.expires_at {
            return Err("Lượt xác minh đã hết hạn sở hữu".to_string());
        }

        // Outcome do renderer báo chỉ ảnh hưởng lịch lần sau, tuyệt đối không
        // xác nhận token hay mở lại native binding đã bị thu hồi.
        let cooldown = match outcome {
            RenewalOutcome::Transient => {
                record.transient_failures = record.transient_failures.saturating_add(1);
                let exponent = record.transient_failures.saturating_sub(1).min(5);
                FAILED_COOLDOWN
                    .saturating_mul(1 << exponent)
                    .min(MAX_TRANSIENT_COOLDOWN)
            }
            RenewalOutcome::Completed => {
                record.transient_failures = 0;
                COMPLETED_COOLDOWN
            }
            RenewalOutcome::RateLimited => {
                record.transient_failures = 0;
                retry
            }
            RenewalOutcome::Failed => {
                record.transient_failures = 0;
                FAILED_COOLDOWN
            }
        };
        record.active = None;
        record.not_before = now.saturating_add(cooldown);
        Ok(FinishRenewalResult {
            retry_after_ms: retry_after_ms(record.not_before, now),
        })
    }

    fn commit(
        &mut self,
        epoch: u64,
        owner: &str,
        attempt_id: &str,
        key_hash: [u8; 32],
        now: Duration,
        operation: impl FnOnce() -> Result<(), String>,
        finished_at: impl FnOnce() -> Duration,
    ) -> Result<FinishRenewalResult, String> {
        if self.epoch != Some(epoch) {
            return Err("Giao dịch thuộc phiên bản quyền cũ".into());
        }
        let record = self
            .record
            .as_ref()
            .ok_or("Không có lượt xác minh đang chờ")?;
        let active = record.active.as_ref().ok_or("Lượt xác minh đã kết thúc")?;
        if active.owner != owner || active.id != attempt_id || record.key_hash != key_hash {
            return Err("Giao dịch không khớp owner hoặc key của lượt xác minh".into());
        }
        if now < active.started_at || now >= active.expires_at {
            return Err("Lượt xác minh đã hết hạn trước commit".into());
        }
        // Hai mutex ngoài được giữ suốt operation: không có begin/clear/store
        // khác chen giữa verify và persistence. TTL chỉ xét khi admit commit.
        let result = operation();
        let cooldown = if result.is_ok() {
            COMPLETED_COOLDOWN
        } else {
            FAILED_COOLDOWN
        };
        if let Some(record) = self.record.as_mut() {
            record.active = None;
            record.transient_failures = 0;
            record.not_before = finished_at().saturating_add(cooldown);
        }
        result?;
        Ok(FinishRenewalResult {
            retry_after_ms: cooldown.as_millis() as u64,
        })
    }
}

fn bounded_rate_limit_retry(
    outcome: RenewalOutcome,
    retry: Option<u64>,
) -> Result<Duration, String> {
    match retry {
        None => Ok(RATE_LIMIT_COOLDOWN),
        Some(seconds)
            if outcome == RenewalOutcome::RateLimited && (1..=3600).contains(&seconds) =>
        {
            Ok(Duration::from_secs(seconds))
        }
        Some(_) => Err("Retry-After chỉ dùng cho rate-limit và phải trong 1–3600 giây".into()),
    }
}

#[command]
pub fn begin_license_renewal(
    window: WebviewWindow,
    license_key: String,
) -> Result<BeginRenewalResult, String> {
    let key_hash = license_key_hash(&license_key)?;
    let mut nonce = [0u8; 16];
    rand::rngs::OsRng
        .try_fill_bytes(&mut nonce)
        .map_err(|_| "Không tạo được định danh lượt xác minh".to_string())?;
    let _transaction = crate::security::license_transaction_guard()?;
    let mut state = RENEWAL_STATE
        .lock()
        .map_err(|_| "Không thể điều phối lượt xác minh bản quyền".to_string())?;
    Ok(state.begin(
        crate::security::license_session_epoch(),
        window.label(),
        key_hash,
        RENEWAL_CLOCK.elapsed(),
        hex::encode(nonce),
    ))
}

#[command]
pub fn finish_license_renewal(
    window: WebviewWindow,
    attempt_id: String,
    outcome: RenewalOutcome,
    retry_after_seconds: Option<u64>,
) -> Result<FinishRenewalResult, String> {
    if attempt_id.len() != 32
        || !attempt_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Định danh lượt xác minh không hợp lệ".to_string());
    }
    let _transaction = crate::security::license_transaction_guard()?;
    let mut state = RENEWAL_STATE
        .lock()
        .map_err(|_| "Không thể kết thúc lượt xác minh bản quyền".to_string())?;
    state.finish_with_retry(
        crate::security::license_session_epoch(),
        window.label(),
        &attempt_id,
        outcome,
        RENEWAL_CLOCK.elapsed(),
        retry_after_seconds,
    )
}

#[command]
pub fn commit_license_renewal(
    window: WebviewWindow,
    attempt_id: String,
    license_key: String,
    token: String,
    challenge: Option<String>,
    challenge_id: Option<String>,
    replace_license_key: Option<String>,
) -> Result<FinishRenewalResult, String> {
    let key_hash = license_key_hash(&license_key)?;
    let _transaction = crate::security::license_transaction_guard()?;
    let mut state = RENEWAL_STATE
        .lock()
        .map_err(|_| "Không khóa được lượt xác minh để commit".to_string())?;
    state.commit(
        crate::security::license_session_epoch(),
        window.label(),
        &attempt_id,
        key_hash,
        RENEWAL_CLOCK.elapsed(),
        || {
            crate::security::commit_license_credentials(
                license_key,
                token,
                challenge,
                challenge_id,
                replace_license_key,
            )
        },
        || RENEWAL_CLOCK.elapsed(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: u64) -> Duration {
        Duration::from_secs(seconds)
    }

    fn begin(
        state: &mut RenewalState,
        epoch: u64,
        owner: &str,
        key: u8,
        now: u64,
        id: &str,
    ) -> BeginRenewalResult {
        state.begin(epoch, owner, [key; 32], at(now), id.to_string())
    }

    #[test]
    fn mot_luot_dang_chay_chan_moi_cua_so_va_key_khac() {
        let mut state = RenewalState::default();
        let started = begin(&mut state, 0, "main", 1, 0, "first");
        assert_eq!(started.status, RenewalStatus::Started);
        assert_eq!(started.attempt_id.as_deref(), Some("first"));
        for key in [1, 2] {
            let busy = begin(&mut state, 0, "document-second", key, 5, "ignored");
            assert_eq!(busy.status, RenewalStatus::Busy);
            assert_eq!(busy.retry_after_ms, 115_000);
            assert_eq!(busy.attempt_id, None);
        }
        assert!(state
            .finish(0, "main", "first", RenewalOutcome::Completed, at(10))
            .is_ok());
    }

    #[test]
    fn cung_key_giu_cooldown_chung_khong_phu_thuoc_cua_so() {
        let mut state = RenewalState::default();
        begin(&mut state, 0, "main", 1, 0, "first");
        assert_eq!(
            state
                .finish(0, "main", "first", RenewalOutcome::Completed, at(1))
                .unwrap()
                .retry_after_ms,
            600_000
        );
        let delayed = begin(&mut state, 0, "document-second", 1, 5, "ignored");
        assert_eq!(delayed.status, RenewalStatus::Cooldown);
        assert_eq!(delayed.retry_after_ms, 596_000);
        assert_eq!(
            begin(&mut state, 0, "document-second", 1, 601, "second").status,
            RenewalStatus::Started
        );
    }

    #[test]
    fn doi_key_sau_khi_luot_cu_ket_thuc_khong_thua_cooldown() {
        let mut state = RenewalState::default();
        begin(&mut state, 0, "main", 1, 0, "first");
        state
            .finish(0, "main", "first", RenewalOutcome::RateLimited, at(1))
            .unwrap();
        assert_eq!(
            begin(&mut state, 0, "main", 2, 2, "second").status,
            RenewalStatus::Started
        );
        assert_eq!(state.record.as_ref().unwrap().key_hash, [2; 32]);
    }

    #[test]
    fn wrong_owner_id_va_replay_khong_sua_luot_hoac_cooldown() {
        let mut state = RenewalState::default();
        begin(&mut state, 0, "main", 1, 0, "first");
        for (owner, id) in [("document-second", "first"), ("main", "wrong")] {
            assert!(state
                .finish(0, owner, id, RenewalOutcome::Failed, at(1))
                .is_err());
        }
        assert_eq!(
            begin(&mut state, 0, "main", 1, 2, "ignored").status,
            RenewalStatus::Busy
        );
        state
            .finish(0, "main", "first", RenewalOutcome::Completed, at(3))
            .unwrap();
        assert!(state
            .finish(0, "main", "first", RenewalOutcome::Failed, at(4))
            .is_err());
        assert_eq!(state.record.as_ref().unwrap().not_before, at(603));
    }

    #[test]
    fn epoch_moi_vo_hieu_luot_cu_va_finish_cu_khong_cham_luot_moi() {
        let mut state = RenewalState::default();
        begin(&mut state, 0, "main", 1, 0, "first");
        assert!(state
            .finish(1, "main", "first", RenewalOutcome::Completed, at(1))
            .is_err());
        assert_eq!(state.epoch, Some(0));
        assert_eq!(
            begin(&mut state, 1, "document-second", 1, 2, "second").status,
            RenewalStatus::Started
        );
        assert!(state
            .finish(1, "main", "first", RenewalOutcome::Failed, at(3))
            .is_err());
        assert!(state
            .finish(
                0,
                "document-second",
                "second",
                RenewalOutcome::Failed,
                at(3)
            )
            .is_err());
        assert!(state
            .finish(
                1,
                "document-second",
                "second",
                RenewalOutcome::Completed,
                at(4)
            )
            .is_ok());
    }

    #[test]
    fn timeout_khong_cho_late_finish_va_khong_tao_vong_lap_tuc_thi() {
        let mut state = RenewalState::default();
        begin(&mut state, 0, "main", 1, 0, "first");
        assert!(state
            .finish(0, "main", "first", RenewalOutcome::Completed, at(120))
            .is_err());
        let delayed = begin(&mut state, 0, "main", 1, 120, "ignored");
        assert_eq!(delayed.status, RenewalStatus::Cooldown);
        assert_eq!(delayed.retry_after_ms, 30_000);
        assert_eq!(
            begin(&mut state, 0, "main", 1, 150, "second").status,
            RenewalStatus::Started
        );
        assert!(state
            .finish(0, "main", "first", RenewalOutcome::Failed, at(151))
            .is_err());
        assert_eq!(
            state.record.as_ref().unwrap().active.as_ref().unwrap().id,
            "second"
        );
    }

    #[test]
    fn transient_backoff_tang_den_muoi_phut_va_reset_sau_success() {
        let mut state = RenewalState::default();
        let mut now = 0;
        for (index, expected) in [30, 60, 120, 240, 480, 600, 600].into_iter().enumerate() {
            let id = format!("attempt-{index}");
            assert_eq!(
                begin(&mut state, 0, "main", 1, now, &id).status,
                RenewalStatus::Started
            );
            let result = state
                .finish(0, "main", &id, RenewalOutcome::Transient, at(now + 1))
                .unwrap();
            assert_eq!(result.retry_after_ms, expected * 1_000);
            now += 1 + expected;
        }
        begin(&mut state, 0, "main", 1, now, "success");
        state
            .finish(0, "main", "success", RenewalOutcome::Completed, at(now + 1))
            .unwrap();
        now += 601;
        begin(&mut state, 0, "main", 1, now, "retry");
        assert_eq!(
            state
                .finish(0, "main", "retry", RenewalOutcome::Transient, at(now + 1))
                .unwrap()
                .retry_after_ms,
            30_000
        );
    }

    #[test]
    fn rate_limit_va_failed_co_thoi_gian_cho_co_dinh() {
        for (outcome, expected) in [
            (RenewalOutcome::RateLimited, 300_000),
            (RenewalOutcome::Failed, 30_000),
        ] {
            let mut state = RenewalState::default();
            begin(&mut state, 0, "main", 1, 0, "first");
            assert_eq!(
                state
                    .finish(0, "main", "first", outcome, at(1))
                    .unwrap()
                    .retry_after_ms,
                expected
            );
        }
    }

    #[test]
    fn hash_key_chuan_hoa_va_khong_giu_key_ro() {
        assert_eq!(
            license_key_hash(" abc-123 ").unwrap(),
            license_key_hash("ABC-123").unwrap()
        );
        assert!(license_key_hash(" ").is_err());
        assert!(license_key_hash(&"x".repeat(257)).is_err());
    }

    #[test]
    fn cooldown_con_phan_le_khong_tra_zero_va_khong_underflow() {
        assert_eq!(retry_after_ms(at(1), Duration::from_micros(999_999)), 1);
        assert_eq!(retry_after_ms(at(1), at(1)), 0);
        assert_eq!(retry_after_ms(at(1), at(2)), 0);
    }

    #[test]
    fn commit_sai_owner_epoch_id_key_hoac_expiry_khong_cham_storage() {
        let mut state = RenewalState::default();
        begin(&mut state, 7, "main", 1, 0, "first");
        for (epoch, owner, id, key, now) in [
            (8, "main", "first", 1, 1),
            (7, "other", "first", 1, 1),
            (7, "main", "other", 1, 1),
            (7, "main", "first", 2, 1),
            (7, "main", "first", 1, 120),
        ] {
            assert!(state
                .commit(
                    epoch,
                    owner,
                    id,
                    [key; 32],
                    at(now),
                    || panic!("Lượt stale không được verify/persist"),
                    || at(now)
                )
                .is_err());
        }
        assert_eq!(
            state.record.as_ref().unwrap().active.as_ref().unwrap().id,
            "first"
        );
    }

    #[test]
    fn commit_duoc_admit_giu_owner_den_cuoi_va_one_shot() {
        let mut state = RenewalState::default();
        begin(&mut state, 7, "main", 1, 0, "first");
        let result = state
            .commit(7, "main", "first", [1; 32], at(119), || Ok(()), || at(300))
            .unwrap();
        assert_eq!(result.retry_after_ms, 600_000);
        assert_eq!(state.record.as_ref().unwrap().not_before, at(900));
        assert!(state
            .commit(
                7,
                "main",
                "first",
                [1; 32],
                at(301),
                || panic!("Không replay persistence"),
                || at(301)
            )
            .is_err());
    }

    #[test]
    fn commit_loi_tieu_thu_attempt_va_hen_retry_khong_bao_thanh_cong() {
        let mut state = RenewalState::default();
        begin(&mut state, 0, "main", 1, 0, "first");
        assert!(state
            .commit(
                0,
                "main",
                "first",
                [1; 32],
                at(1),
                || Err("persist failed".into()),
                || at(2)
            )
            .is_err());
        assert!(state.record.as_ref().unwrap().active.is_none());
        assert_eq!(state.record.as_ref().unwrap().not_before, at(32));
    }

    #[test]
    fn retry_after_server_dung_so_giay_va_chi_anh_huong_rate_limit() {
        for seconds in [1, 30, 600, 3600] {
            let mut state = RenewalState::default();
            begin(&mut state, 0, "main", 1, 0, "first");
            assert_eq!(
                state
                    .finish_with_retry(
                        0,
                        "main",
                        "first",
                        RenewalOutcome::RateLimited,
                        at(1),
                        Some(seconds)
                    )
                    .unwrap()
                    .retry_after_ms,
                seconds * 1000
            );
        }
        for seconds in [0, 3601] {
            assert!(bounded_rate_limit_retry(RenewalOutcome::RateLimited, Some(seconds)).is_err());
        }
        assert!(bounded_rate_limit_retry(RenewalOutcome::Completed, Some(10)).is_err());
        assert_eq!(
            bounded_rate_limit_retry(RenewalOutcome::RateLimited, None).unwrap(),
            RATE_LIMIT_COOLDOWN
        );
    }

    #[test]
    fn api_json_chi_co_lich_khong_co_token_hay_quyen() {
        let result = BeginRenewalResult {
            status: RenewalStatus::Started,
            attempt_id: Some("opaque-id".to_string()),
            retry_after_ms: 0,
        };
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({"status":"started", "attemptId":"opaque-id", "retryAfterMs":0})
        );
        assert_eq!(
            serde_json::to_value(BeginRenewalResult {
                status: RenewalStatus::Busy,
                attempt_id: None,
                retry_after_ms: 120_000,
            })
            .unwrap(),
            serde_json::json!({"status":"busy", "retryAfterMs":120_000})
        );
        assert_eq!(
            serde_json::from_str::<RenewalOutcome>("\"rate_limited\"").unwrap(),
            RenewalOutcome::RateLimited
        );
        assert!(serde_json::from_str::<RenewalOutcome>("\"grant_license\"").is_err());
    }
}
