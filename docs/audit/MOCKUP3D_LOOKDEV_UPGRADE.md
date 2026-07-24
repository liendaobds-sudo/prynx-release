# Mockup 3D Lookdev Upgrade — PR1–PR3 (2026-07-24)

## Phạm vi đã ship

| PR | Nội dung | Trạng thái |
|----|----------|------------|
| PR1 | `FinishSpec` Physical (clearcoat/sheen/envMapIntensity/grain hint) + `resolvePhysicalScalars` + PBT | Done |
| PR2 | `SolidPanelMesh` / `GussetMesh` → `MeshPhysicalMaterial`; spot-UV roughness **và** clearcoat threshold | Done |
| PR3 | `qualityTier` (env 256/512), `toneExposure` slider, export 2×/4× tạm bật high | Done |

## PR4–PR5 (đã ship)

| PR | Nội dung |
|----|----------|
| PR4 | `proceduralTextures.ts` kraft grain + toggle **Sợi giấy** + quality size 256/512 |
| PR5 | `heroTimeline.ts` + nút 🎬 Demo gập; reduced-motion; dừng khi kéo orbit/slider |

## Chưa làm (P2)

- Edge bevel geometry / crease response
- AgX tone mapping optional

## Tham chiếu research

- `tmp/research/img2threejs-showcase` (gitignored) — pattern clearcoat/sheen/lookdev
- Không port model demo; chỉ recipe PBR

## Cách kiểm tra tay

1. Mở tool Khuôn bế → tab Mô phỏng 3D.
2. Đổi finish: kraft (sheen), matte-lam vs gloss-lam (clearcoat), foil (không wash trắng), spot-UV + mask.
3. Cảnh → Chất lượng **Cao** (env 512); kéo **Phơi sáng**.
4. Xuất PNG 2× — tự bump quality high rồi restore.
