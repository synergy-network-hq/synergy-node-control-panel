/**
 * electron-builder afterPack hook.
 *
 * On macOS, ad-hoc signs the .app bundle so Gatekeeper allows
 * right-click > Open without needing `xattr -cr`.
 * This runs BEFORE the DMG/ZIP are created, so the distributed
 * installers contain an ad-hoc signed app.
 */
const { execSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[afterPack] Ad-hoc signing macOS app: ${appPath}`);

  try {
    // Remove any existing signatures first
    execSync(`codesign --remove-signature "${appPath}" 2>/dev/null || true`, {
      stdio: 'inherit',
    });

    // Ad-hoc sign with deep flag to cover all frameworks and helpers
    execSync(
      `codesign --force --deep --sign - --entitlements /dev/null "${appPath}"`,
      { stdio: 'inherit' },
    );

    console.log('[afterPack] Ad-hoc signing complete.');
  } catch (error) {
    console.warn(`[afterPack] Ad-hoc signing failed (non-fatal): ${error.message}`);
  }
};
