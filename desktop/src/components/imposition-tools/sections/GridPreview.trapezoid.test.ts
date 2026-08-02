import { describe, expect, it } from "vitest";

import { resolveTrapezoidPreviewRatios } from "./GridPreview";

describe("resolveTrapezoidPreviewRatios", () => {
  it("fallback khi response width-profile cũ thiếu bbox", () => {
    expect(
      resolveTrapezoidPreviewRatios({
        isHorizontal: false,
        longBase: 232.21,
        shortBase: 71.76,
      }),
    ).toBeNull();
  });

  it("chỉ trả tỷ lệ hữu hạn khi bbox hợp lệ", () => {
    const result = resolveTrapezoidPreviewRatios({
      isHorizontal: false,
      longBase: 232.21,
      shortBase: 71.76,
      bbW: 232.393,
      bbH: 245.65,
    });

    expect(result).not.toBeNull();
    expect(result?.longRatio).toBeCloseTo(232.21 / 245.65);
    expect(result?.shortRatio).toBeCloseTo(71.76 / 245.65);
    expect(Number.isFinite(result?.longRatio)).toBe(true);
    expect(Number.isFinite(result?.shortRatio)).toBe(true);
  });

  it("từ chối bbox không phải số", () => {
    expect(
      resolveTrapezoidPreviewRatios({
        isHorizontal: false,
        longBase: 232.21,
        shortBase: 71.76,
        bbH: "NaN",
      }),
    ).toBeNull();
  });
});
