// UIUX (audit 2026-08-24 LO101): helper thuần tách khỏi component để Fast Refresh
// chỉ phải theo dõi component React, không reset preview khi module được cập nhật.

const SAME_SIZE_ONLY_MESSAGE = "chỉ hỗ trợ các trang cùng kích thước";

export function shouldAutoSwitchToMixedGuillotine({
  status,
  message,
  taskMode,
  layoutType,
  isDieCut,
  pageSheetMode,
  imposerMode,
}: {
  status: number;
  message: string;
  taskMode: string;
  layoutType?: string;
  isDieCut?: boolean;
  pageSheetMode?: boolean;
  imposerMode?: string;
}): boolean {
  return (
    status === 422 &&
    taskMode === "nup" &&
    !isDieCut &&
    !pageSheetMode &&
    imposerMode !== "cnc" &&
    ["sequential", "cut_stacks", "ratio_stack"].includes(layoutType || "") &&
    message.toLocaleLowerCase("vi").includes(SAME_SIZE_ONLY_MESSAGE)
  );
}

export type CellDirectionDegrees = 0 | 90 | 180 | 270;

export function resolveCellDirectionDegrees(
  isRotated: boolean,
  isRotated180: boolean,
): CellDirectionDegrees {
  return (((isRotated ? 90 : 0) + (isRotated180 ? 180 : 0)) % 360) as CellDirectionDegrees;
}

export function resolveTrapezoidPreviewRatios(
  shapeProps: Record<string, unknown> | null,
): { isHorizontal: boolean; longRatio: number; shortRatio: number } | null {
  if (!shapeProps) return null;

  const isHorizontal = shapeProps.isHorizontal === true;
  const longBase = Number(shapeProps.longBase);
  const shortBase = Number(shapeProps.shortBase);
  const bboxExtent = Number(isHorizontal ? shapeProps.bbW : shapeProps.bbH);

  // Cache cũ có thể thiếu bbox; không để NaN lọt xuống thuộc tính SVG.
  if (
    !Number.isFinite(longBase) ||
    !Number.isFinite(shortBase) ||
    !Number.isFinite(bboxExtent) ||
    longBase <= 0 ||
    shortBase <= 0 ||
    bboxExtent <= 0
  ) {
    return null;
  }

  return {
    isHorizontal,
    longRatio: longBase / bboxExtent,
    shortRatio: shortBase / bboxExtent,
  };
}
