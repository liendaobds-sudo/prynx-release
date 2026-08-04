import { useCallback } from 'react';

import { toast } from '../components/ui/Toast';
import { FEATURE_CATALOG, canUse, type FeatureId, type LicensePlan } from '../lib/license/features';
import { findToolByUniqueKey, type ToolDefinition } from '../lib/toolRegistry';
import { useAuthStore } from '../stores/useAuthStore';

type AccessDenied = (featureId: FeatureId) => void;

/**
 * UIUX/SEC (audit 2026-08-04 §UI.01/§UI.03): một quyết định quyền duy nhất cho
 * mọi cửa kích hoạt và mọi thao tác client-only. Callback chỉ chạy sau khi quyền
 * hiện tại đã được đọc lại, nên đổi key/hạ gói không dùng snapshot cũ.
 */
export function requestFeatureAccess(
  featureId: FeatureId,
  plan: LicensePlan | string,
  features: readonly string[] | null,
  onAllowed: () => void,
  onDenied?: AccessDenied,
): boolean {
  if (!canUse(featureId, plan, features)) {
    onDenied?.(featureId);
    return false;
  }
  onAllowed();
  return true;
}

export function requestToolActivation(
  tool: ToolDefinition,
  plan: LicensePlan | string,
  features: readonly string[] | null,
  onAllowed: () => void,
  onDenied?: AccessDenied,
): boolean {
  return requestFeatureAccess(tool.featureId, plan, features, onAllowed, onDenied);
}

/**
 * Hai state nội bộ không phải item registry: `none` đóng panel và `merge` là
 * panel ghép file cũ trong workspace. Mọi key khác thiếu registry phải
 * fail-closed, kể cả tool đang tắt như OCR.
 */
export function requestWorkspaceToolActivation(
  toolKey: string,
  plan: LicensePlan | string,
  features: readonly string[] | null,
  onAllowed: () => void,
  onDenied?: AccessDenied,
  onUnknown?: (toolKey: string) => void,
): boolean {
  if (toolKey === 'none' || toolKey === 'merge') {
    onAllowed();
    return true;
  }
  const tool = findToolByUniqueKey(toolKey);
  if (!tool) {
    onUnknown?.(toolKey);
    return false;
  }
  return requestToolActivation(tool, plan, features, onAllowed, onDenied);
}

function showUpgradeNotice(featureId: FeatureId): void {
  toast.info(`Tính năng ${FEATURE_CATALOG[featureId].label} dành cho PrynX Pro.`);
}

/** Guard chuẩn cho việc mở/chuyển công cụ. */
export function useToolActivationGuard() {
  return useCallback((tool: ToolDefinition, onAllowed: () => void): boolean => {
    // Đọc getState tại đúng thời điểm click; không dùng snapshot của lần render
    // trước vì token có thể vừa refresh/downgrade giữa hai frame.
    const { licensePlan, licenseFeatures } = useAuthStore.getState();
    return requestToolActivation(tool, licensePlan, licenseFeatures, onAllowed, showUpgradeNotice);
  }, []);
}

/** Guard chuẩn cho state activeDashboardTool của workspace. */
export function useWorkspaceToolActivationGuard() {
  return useCallback((toolKey: string, onAllowed: () => void): boolean => {
    const { licensePlan, licenseFeatures } = useAuthStore.getState();
    return requestWorkspaceToolActivation(
      toolKey,
      licensePlan,
      licenseFeatures,
      onAllowed,
      showUpgradeNotice,
      () => toast.info('Công cụ chưa được phân loại quyền nên đã bị chặn.'),
    );
  }, []);
}

/** Guard chuẩn cho hành động có giá trị chạy hoàn toàn trong WebView. */
export function useFeatureActionGuard() {
  return useCallback((featureId: FeatureId, onAllowed: () => void): boolean => {
    const { licensePlan, licenseFeatures } = useAuthStore.getState();
    return requestFeatureAccess(featureId, licensePlan, licenseFeatures, onAllowed, showUpgradeNotice);
  }, []);
}
