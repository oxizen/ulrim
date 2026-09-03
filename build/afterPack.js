// electron-builder afterPack hook (macOS only).
//
// electron-builder는 macOS 패키징 시 파일/폴더 이름을 NFD로 정규화한다
// (codesign이 NFC 한글 파일명을 제대로 seal 하지 못하기 때문). 그런데
// Info.plist 의 CFBundleName 은 NFC 그대로라서, Electron 이 CFBundleName 으로
// 조립하는 헬퍼 경로("울림 Helper.app", NFC)와 실제 폴더명(NFD)이 어긋나
// 앱이 실행 직후 SIGTRAP 으로 죽는다. 서명 전에 CFBundleName 을 NFD 로 맞춰준다.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  for (const name of fs.readdirSync(context.appOutDir)) {
    if (!name.endsWith('.app')) continue;
    const plist = path.join(context.appOutDir, name, 'Contents', 'Info.plist');
    const bundleName = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleName', plist], { encoding: 'utf8' }).trim();
    const nfd = bundleName.normalize('NFD');
    if (nfd === bundleName) continue;
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleName ${nfd}`, plist]);
    console.log(`  • afterPack: CFBundleName normalized to NFD for ${name}`);
  }
};
