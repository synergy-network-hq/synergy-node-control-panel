const baseUrl = String(import.meta.env?.BASE_URL || '/');

export function runtimeAsset(path) {
  const normalizedPath = String(path || '').replace(/^\/+/, '');
  if (!normalizedPath) {
    return baseUrl;
  }
  return `${baseUrl}${normalizedPath}`;
}

export const brandLogoSrc = runtimeAsset('branding/assets/snrg-logo.png');
export const controlPanelBannerSrc = runtimeAsset('branding/assets/control-panel-banner.png');
export const ecosystemHeaderGifSrc = runtimeAsset('branding/assets/ecobanner.gif');
export const splashBrandGifSrc = runtimeAsset('branding/assets/snrg-splash.gif');
