const baseUrl = String(import.meta.env?.BASE_URL || '/');

export function runtimeAsset(path) {
  const normalizedPath = String(path || '').replace(/^\/+/, '');
  if (!normalizedPath) {
    return baseUrl;
  }
  return `${baseUrl}${normalizedPath}`;
}

export const brandLogoSrc = runtimeAsset('snrg.gif');
