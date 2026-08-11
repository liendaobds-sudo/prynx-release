use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;
const LOW_DISK_FREE_BYTES: u64 = 5 * GIB;
const MID_DISK_FREE_BYTES: u64 = 20 * GIB;
const LOW_DISK_CACHE_BYTES: u64 = 128 * MIB;
const MID_DISK_CACHE_BYTES: u64 = 512 * MIB;
const HIGH_DISK_CACHE_BYTES: u64 = 2 * GIB;
const DEFAULT_MIN_FREE_BYTES: u64 = 2 * GIB;
const MAX_MIN_FREE_BYTES: u64 = 20 * GIB;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const PNG_IEND_TRAILER: &[u8; 12] = b"\x00\x00\x00\x00IEND\xaeB\x60\x82";

static PRUNE_RUNNING: AtomicBool = AtomicBool::new(false);
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static CONFIG_OVERRIDES: OnceLock<TileDiskOverrides> = OnceLock::new();

pub(crate) fn is_valid_tile_png(data: &[u8]) -> bool {
    data.starts_with(PNG_SIGNATURE) && data.ends_with(PNG_IEND_TRAILER)
}

pub(crate) fn read_valid_tile_png(path: &Path) -> Option<Vec<u8>> {
    let data = std::fs::read(path).ok()?;
    if is_valid_tile_png(&data) {
        return Some(data);
    }
    // Cache hỏng không phải dữ liệu người dùng; xóa để lần kế tiếp render lại sạch.
    let _ = std::fs::remove_file(path);
    None
}

pub(crate) fn write_tile_png_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    if !is_valid_tile_png(data) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Dữ liệu cache tile không phải PNG hoàn chỉnh.",
        ));
    }
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("tile.png");
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = directory.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        sequence
    ));

    let result = (|| {
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        output.write_all(data)?;
        output.flush()?;
        drop(output);
        // Cùng thư mục/volume: rename thay target theo một bước, request đua nhau chỉ
        // thay một PNG hoàn chỉnh bằng PNG hoàn chỉnh khác cùng cache key.
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DiskSpaceStatus {
    total_bytes: u64,
    available_bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct TileDiskPolicy {
    max_bytes: Option<u64>,
    min_free_bytes: u64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct TileDiskOverrides {
    max_bytes: Option<Option<u64>>,
    min_free_bytes: Option<u64>,
}

#[derive(Debug)]
struct TileDiskEntry {
    path: PathBuf,
    modified: std::time::SystemTime,
    bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TileDiskWriteDecision {
    pub write: bool,
    pub prune_interval: usize,
}

fn tile_disk_policy_for_space(status: Option<DiskSpaceStatus>) -> TileDiskPolicy {
    let max_bytes = match status.map(|value| value.available_bytes) {
        Some(bytes) if bytes < LOW_DISK_FREE_BYTES => Some(LOW_DISK_CACHE_BYTES),
        Some(bytes) if bytes < MID_DISK_FREE_BYTES => Some(MID_DISK_CACHE_BYTES),
        Some(_) => Some(HIGH_DISK_CACHE_BYTES),
        None => Some(MID_DISK_CACHE_BYTES),
    };
    let min_free_bytes = status
        .map(|value| (value.total_bytes / 50).clamp(DEFAULT_MIN_FREE_BYTES, MAX_MIN_FREE_BYTES))
        .unwrap_or(DEFAULT_MIN_FREE_BYTES);
    TileDiskPolicy {
        max_bytes,
        min_free_bytes,
    }
}

fn parse_cache_budget_override(raw: Option<&str>) -> Option<Option<u64>> {
    let value_mb = raw?.trim().parse::<u64>().ok()?;
    if value_mb == 0 {
        return Some(None);
    }
    value_mb.checked_mul(MIB).map(Some)
}

fn parse_min_free_override(raw: Option<&str>) -> Option<u64> {
    raw?.trim().parse::<u64>().ok()?.checked_mul(MIB)
}

fn tile_disk_overrides() -> TileDiskOverrides {
    *CONFIG_OVERRIDES.get_or_init(|| {
        let max_bytes = std::env::var("PRYNX_TILE_DISK_CACHE_MB")
            .ok()
            .and_then(|raw| match parse_cache_budget_override(Some(&raw)) {
                Some(value) => Some(value),
                None => {
                    log::warn!("[TILE-DISK] Bỏ qua PRYNX_TILE_DISK_CACHE_MB không hợp lệ: {raw}");
                    None
                }
            });
        let min_free_bytes = std::env::var("PRYNX_MIN_FREE_DISK_MB")
            .ok()
            .and_then(|raw| match parse_min_free_override(Some(&raw)) {
                Some(value) => Some(value),
                None => {
                    log::warn!("[TILE-DISK] Bỏ qua PRYNX_MIN_FREE_DISK_MB không hợp lệ: {raw}");
                    None
                }
            });
        TileDiskOverrides {
            max_bytes,
            min_free_bytes,
        }
    })
}

fn configured_tile_disk_policy(status: Option<DiskSpaceStatus>) -> TileDiskPolicy {
    let mut policy = tile_disk_policy_for_space(status);
    let overrides = tile_disk_overrides();
    if let Some(max_bytes) = overrides.max_bytes {
        policy.max_bytes = max_bytes;
    }
    if let Some(min_free_bytes) = overrides.min_free_bytes {
        policy.min_free_bytes = min_free_bytes;
    }
    policy
}

#[cfg(target_os = "windows")]
fn disk_space_status(path: &Path) -> Option<DiskSpaceStatus> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let directory = if path.is_dir() { path } else { path.parent()? };
    let wide = directory
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut available_bytes = 0_u64;
    let mut total_bytes = 0_u64;
    unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR(wide.as_ptr()),
            Some(&mut available_bytes),
            Some(&mut total_bytes),
            None,
        )
        .ok()?;
    }
    (total_bytes > 0 && available_bytes <= total_bytes).then_some(DiskSpaceStatus {
        total_bytes,
        available_bytes,
    })
}

#[cfg(not(target_os = "windows"))]
fn disk_space_status(_path: &Path) -> Option<DiskSpaceStatus> {
    None
}

fn should_write_tile_disk_cache(
    status: Option<DiskSpaceStatus>,
    policy: TileDiskPolicy,
    incoming_bytes: u64,
) -> bool {
    let Some(status) = status else {
        return true;
    };
    status.available_bytes >= policy.min_free_bytes.saturating_add(incoming_bytes)
}

fn tile_disk_prune_interval(policy: TileDiskPolicy) -> usize {
    match policy.max_bytes {
        Some(bytes) if bytes <= LOW_DISK_CACHE_BYTES => 16,
        Some(bytes) if bytes <= MID_DISK_CACHE_BYTES => 32,
        _ => 64,
    }
}

fn plan_tile_disk_removals(
    mut entries: Vec<TileDiskEntry>,
    policy: TileDiskPolicy,
    available_bytes: Option<u64>,
) -> Vec<PathBuf> {
    let total_bytes = entries
        .iter()
        .fold(0_u64, |total, entry| total.saturating_add(entry.bytes));
    let quota_reclaim = policy
        .max_bytes
        .map(|max_bytes| total_bytes.saturating_sub(max_bytes))
        .unwrap_or(0);
    let reserve_reclaim = available_bytes
        .map(|available| policy.min_free_bytes.saturating_sub(available))
        .unwrap_or(0);
    let target_reclaim = quota_reclaim.max(reserve_reclaim);
    if target_reclaim == 0 {
        return Vec::new();
    }

    entries.sort_by(|left, right| {
        left.modified
            .cmp(&right.modified)
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut reclaimed = 0_u64;
    let mut removals = Vec::new();
    for entry in entries {
        reclaimed = reclaimed.saturating_add(entry.bytes);
        removals.push(entry.path);
        if reclaimed >= target_reclaim {
            break;
        }
    }
    removals
}

fn is_owned_tile_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    // COLOR (audit 2026-08-07 §GV.1): dọn cả PNG lossless hiện tại và JPEG legacy.
    // Chỉ nhận đúng tên hash trực tiếp để tuyệt đối không xóa file ngoại lai.
    let Some(stem) = name
        .strip_suffix(".png")
        .or_else(|| name.strip_suffix(".jpg"))
    else {
        return false;
    };
    stem.len() == 16 && stem.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn collect_tile_disk_entries(dir: &Path) -> Vec<TileDiskEntry> {
    let mut entries = Vec::new();
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return entries;
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !is_owned_tile_file(&path) {
            continue;
        }
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        entries.push(TileDiskEntry {
            path,
            modified: metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
            bytes: metadata.len(),
        });
    }
    entries
}

fn prune_tile_disk_cache(dir: &Path) {
    let status = disk_space_status(dir);
    let policy = configured_tile_disk_policy(status);
    let entries = collect_tile_disk_entries(dir);
    let scanned_bytes = entries
        .iter()
        .fold(0_u64, |total, entry| total.saturating_add(entry.bytes));
    let removals =
        plan_tile_disk_removals(entries, policy, status.map(|value| value.available_bytes));
    let mut removed_files = 0_u64;
    let mut removed_bytes = 0_u64;
    for path in removals {
        let bytes = std::fs::metadata(&path)
            .map(|value| value.len())
            .unwrap_or(0);
        if std::fs::remove_file(&path).is_ok() {
            removed_files += 1;
            removed_bytes = removed_bytes.saturating_add(bytes);
        }
    }
    let budget = policy
        .max_bytes
        .map(|bytes| bytes.to_string())
        .unwrap_or_else(|| "unbounded".to_string());
    super::perf_log(&format!(
        "TILE_DISK_PRUNE scanned_bytes={scanned_bytes} removed_bytes={removed_bytes} removed_files={removed_files} budget_bytes={budget} min_free_bytes={}",
        policy.min_free_bytes
    ));
}

pub(crate) fn tile_disk_write_decision(
    path: &Path,
    incoming_bytes: usize,
) -> TileDiskWriteDecision {
    let status = disk_space_status(path);
    let policy = configured_tile_disk_policy(status);
    TileDiskWriteDecision {
        write: should_write_tile_disk_cache(status, policy, incoming_bytes as u64),
        prune_interval: tile_disk_prune_interval(policy),
    }
}

pub(crate) fn schedule_tile_disk_prune(dir: PathBuf) {
    if PRUNE_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    std::thread::spawn(move || {
        struct ResetPruneFlag;
        impl Drop for ResetPruneFlag {
            fn drop(&mut self) {
                PRUNE_RUNNING.store(false, Ordering::Release);
            }
        }
        let _reset = ResetPruneFlag;
        prune_tile_disk_cache(&dir);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1024 * 1024;
    const GIB: u64 = 1024 * MIB;

    fn entry(name: &str, modified_secs: u64, bytes: u64) -> TileDiskEntry {
        TileDiskEntry {
            path: std::path::PathBuf::from(name),
            modified: std::time::UNIX_EPOCH + std::time::Duration::from_secs(modified_secs),
            bytes,
        }
    }

    #[test]
    fn quota_byte_removes_oldest_entries_until_total_fits() {
        let entries = vec![
            entry("old.jpg", 1, 4),
            entry("middle.jpg", 2, 4),
            entry("new.jpg", 3, 5),
        ];
        let policy = TileDiskPolicy {
            max_bytes: Some(9),
            min_free_bytes: 0,
        };

        let removals = plan_tile_disk_removals(entries, policy, Some(100));

        assert_eq!(removals, vec![std::path::PathBuf::from("old.jpg")]);
    }

    #[test]
    fn free_space_reserve_can_reclaim_more_than_cache_quota_requires() {
        let entries = vec![
            entry("old.jpg", 1, 4),
            entry("middle.jpg", 2, 4),
            entry("new.jpg", 3, 4),
        ];
        let policy = TileDiskPolicy {
            max_bytes: Some(100),
            min_free_bytes: 10,
        };

        let removals = plan_tile_disk_removals(entries, policy, Some(3));

        assert_eq!(
            removals,
            vec![
                std::path::PathBuf::from("old.jpg"),
                std::path::PathBuf::from("middle.jpg"),
            ]
        );
    }

    #[test]
    fn disk_policy_scales_with_free_space_and_keeps_a_volume_reserve() {
        let total = 500 * GIB;
        assert_eq!(
            tile_disk_policy_for_space(Some(DiskSpaceStatus {
                total_bytes: total,
                available_bytes: 4 * GIB,
            })),
            TileDiskPolicy {
                max_bytes: Some(128 * MIB),
                min_free_bytes: 10 * GIB,
            }
        );
        assert_eq!(
            tile_disk_policy_for_space(Some(DiskSpaceStatus {
                total_bytes: total,
                available_bytes: 10 * GIB,
            }))
            .max_bytes,
            Some(512 * MIB)
        );
        assert_eq!(
            tile_disk_policy_for_space(Some(DiskSpaceStatus {
                total_bytes: total,
                available_bytes: 50 * GIB,
            }))
            .max_bytes,
            Some(2 * GIB)
        );
    }

    #[test]
    fn write_guard_skips_cache_only_when_free_space_would_cross_reserve() {
        let policy = TileDiskPolicy {
            max_bytes: Some(128 * MIB),
            min_free_bytes: 2 * GIB,
        };
        assert!(should_write_tile_disk_cache(None, policy, 1 * MIB));
        assert!(should_write_tile_disk_cache(
            Some(DiskSpaceStatus {
                total_bytes: 100 * GIB,
                available_bytes: 2 * GIB + MIB,
            }),
            policy,
            MIB,
        ));
        assert!(!should_write_tile_disk_cache(
            Some(DiskSpaceStatus {
                total_bytes: 100 * GIB,
                available_bytes: 2 * GIB + MIB - 1,
            }),
            policy,
            MIB,
        ));
    }

    #[test]
    fn low_disk_tiers_prune_more_often_without_slowing_large_disks() {
        assert_eq!(
            tile_disk_prune_interval(TileDiskPolicy {
                max_bytes: Some(128 * MIB),
                min_free_bytes: 0,
            }),
            16
        );
        assert_eq!(
            tile_disk_prune_interval(TileDiskPolicy {
                max_bytes: Some(512 * MIB),
                min_free_bytes: 0,
            }),
            32
        );
        assert_eq!(
            tile_disk_prune_interval(TileDiskPolicy {
                max_bytes: Some(2 * GIB),
                min_free_bytes: 0,
            }),
            64
        );
        assert_eq!(
            tile_disk_prune_interval(TileDiskPolicy {
                max_bytes: None,
                min_free_bytes: 0,
            }),
            64
        );
    }

    #[test]
    fn overrides_support_unbounded_and_reject_invalid_or_overflow_values() {
        assert_eq!(
            parse_cache_budget_override(Some("256")),
            Some(Some(256 * MIB))
        );
        assert_eq!(parse_cache_budget_override(Some("0")), Some(None));
        assert_eq!(parse_cache_budget_override(Some("invalid")), None);
        assert_eq!(
            parse_cache_budget_override(Some(&u64::MAX.to_string())),
            None
        );
        assert_eq!(parse_min_free_override(Some("2048")), Some(2 * GIB));
        assert_eq!(parse_min_free_override(Some("invalid")), None);
    }

    #[test]
    fn only_accepts_direct_hash_named_viewer_tiles() {
        assert!(is_owned_tile_file(std::path::Path::new(
            "0123456789abcdef.jpg"
        )));
        assert!(is_owned_tile_file(std::path::Path::new(
            "0123456789abcdef.png"
        )));
        assert!(!is_owned_tile_file(std::path::Path::new("not-a-tile.jpg")));
        assert!(!is_owned_tile_file(std::path::Path::new(
            "../0123456789abcdef.jpg.tmp"
        )));
    }

    #[test]
    fn collector_ignores_foreign_files_and_directories() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "prynx_tile_disk_test_{}_{}",
            std::process::id(),
            stamp
        ));
        assert!(!is_owned_tile_file(std::path::Path::new(
            "../0123456789abcdef.png.tmp"
        )));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("0123456789abcdef.jpg"), [1_u8, 2, 3]).unwrap();
        std::fs::write(root.join("fedcba9876543210.png"), [6_u8, 7, 8, 9]).unwrap();
        std::fs::write(root.join("ghi-chu.txt"), [4_u8, 5]).unwrap();
        std::fs::create_dir_all(root.join("0011223344556677.png")).unwrap();

        let entries = collect_tile_disk_entries(&root);

        assert_eq!(entries.len(), 2);
        assert_eq!(entries.iter().map(|entry| entry.bytes).sum::<u64>(), 7);
        assert!(entries.iter().any(|entry| {
            entry.path.file_name().and_then(|value| value.to_str()) == Some("fedcba9876543210.png")
        }));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn png_cache_chi_nhan_file_du_header_va_iend() {
        let valid = [
            b"\x89PNG\r\n\x1a\n".as_slice(),
            b"payload".as_slice(),
            b"\x00\x00\x00\x00IEND\xaeB\x60\x82".as_slice(),
        ]
        .concat();
        assert!(is_valid_tile_png(&valid));
        assert!(!is_valid_tile_png(b"not-empty-but-not-png"));
        assert!(!is_valid_tile_png(&valid[..valid.len() - 4]));
    }

    #[test]
    fn ghi_atomic_va_doc_cache_hong_tu_don_file() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "prynx_tile_atomic_test_{}_{}",
            std::process::id(),
            stamp
        ));
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("0123456789abcdef.png");
        let valid = [
            b"\x89PNG\r\n\x1a\n".as_slice(),
            b"payload".as_slice(),
            b"\x00\x00\x00\x00IEND\xaeB\x60\x82".as_slice(),
        ]
        .concat();

        write_tile_png_atomic(&target, &valid).unwrap();
        assert_eq!(read_valid_tile_png(&target), Some(valid));
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);

        let replacement = [
            b"\x89PNG\r\n\x1a\n".as_slice(),
            b"replacement".as_slice(),
            b"\x00\x00\x00\x00IEND\xaeB\x60\x82".as_slice(),
        ]
        .concat();
        write_tile_png_atomic(&target, &replacement).unwrap();
        assert_eq!(read_valid_tile_png(&target), Some(replacement));

        std::fs::write(&target, b"truncated").unwrap();
        assert_eq!(read_valid_tile_png(&target), None);
        assert!(!target.exists());
        assert!(write_tile_png_atomic(&target, b"invalid").is_err());
        assert!(!target.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_reports_valid_space_for_temp_directory() {
        let status = disk_space_status(&std::env::temp_dir()).unwrap();
        assert!(status.total_bytes > 0);
        assert!(status.available_bytes <= status.total_bytes);
    }
}
