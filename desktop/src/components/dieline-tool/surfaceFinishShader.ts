import {
    SPOT_UV_GLOSS_CLEARCOAT,
    SPOT_UV_GLOSS_CLEARCOAT_ROUGHNESS,
    SPOT_UV_GLOSS_ROUGHNESS,
} from '../../lib/mockup3d/materialLibrary';

const SPOT_UV_ROUGHNESS_SHADER_TARGET = 'roughnessFactor *= texelRoughness.g;';

/** Áp mask Spot-UV lên roughness của shader Physical. */
export function patchSpotUvRoughnessShader(fragmentShader: string): string {
    return fragmentShader.replace(
        SPOT_UV_ROUGHNESS_SHADER_TARGET,
        `roughnessFactor = texelRoughness.g > 0.5 ? ${SPOT_UV_GLOSS_ROUGHNESS.toFixed(4)} : roughnessFactor;`,
    );
}

/** Áp mask Spot-UV lên clearcoat và độ nhám clearcoat. */
export function patchSpotUvClearcoatShader(fragmentShader: string): string {
    const targets = [
        'clearcoatFactor *= texelClearcoat.x;',
        'clearcoatFactor *= texelClearcoat.r;',
    ];
    let out = fragmentShader;
    for (const target of targets) {
        if (out.includes(target)) {
            out = out.replace(
                target,
                `clearcoatFactor = texelClearcoat.x > 0.5 ? ${SPOT_UV_GLOSS_CLEARCOAT.toFixed(4)} : clearcoatFactor;`,
            );
            break;
        }
    }
    const roughTargets = [
        'clearcoatRoughnessFactor *= texelClearcoatRoughness.y;',
        'clearcoatRoughnessFactor *= texelClearcoatRoughness.g;',
    ];
    for (const target of roughTargets) {
        if (out.includes(target)) {
            out = out.replace(
                target,
                `clearcoatRoughnessFactor = texelClearcoatRoughness.y > 0.5 ? ${SPOT_UV_GLOSS_CLEARCOAT_ROUGHNESS.toFixed(4)} : clearcoatRoughnessFactor;`,
            );
            break;
        }
    }
    return out;
}

/** Áp đồng thời roughness và clearcoat cho shader Spot-UV. */
export function patchSpotUvPhysicalShader(fragmentShader: string): string {
    return patchSpotUvClearcoatShader(patchSpotUvRoughnessShader(fragmentShader));
}
