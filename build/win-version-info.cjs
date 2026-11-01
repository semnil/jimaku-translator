// artifactBuildStarted hook: embeds the icon and version info into the Windows
// exe via rcedit when the NSIS target starts. electron-builder edits the exe's
// resources after afterPack, and the NSIS target packs the app directory after
// this event, so the values written here are the ones the installer ships.
// afterPack calls record() with each Windows app it packed; the hook fails when
// the NSIS target starts with nothing recorded.
const path = require('path');

const apps = [];

async function writeVersionInfo({ exePath, productName }) {
  // rcedit 5 is ESM-only and exports `rcedit` as a named export; load it with
  // dynamic import() from this CJS hook (require() cannot load an ESM module)
  const { rcedit } = await import('rcedit');
  const icoPath = path.resolve(__dirname, 'icon.ico');
  const pkg = require('../package.json');
  const version = pkg.version;
  const companyName = pkg.author || 'semnil';
  const copyright = `Copyright (C) ${new Date().getFullYear()} ${companyName}`;
  console.log(`[artifactBuildStarted] Setting icon and version info on ${exePath}`);
  await rcedit(exePath, {
    icon: icoPath,
    'file-version': version,
    'product-version': version,
    'version-string': {
      CompanyName: companyName,
      FileDescription: productName,
      ProductName: productName,
      OriginalFilename: `${productName}.exe`,
      InternalName: productName,
      LegalCopyright: copyright,
    },
  });
}

module.exports = async function (event) {
  if (event.targetPresentableName !== 'nsis') return;
  if (apps.length === 0) {
    throw new Error('[artifactBuildStarted] the NSIS target started, but afterPack recorded no Windows app');
  }
  for (const app of apps) await writeVersionInfo(app);
};

module.exports.record = function (context) {
  apps.push({
    exePath: path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`),
    productName: context.packager.appInfo.productName,
  });
};
