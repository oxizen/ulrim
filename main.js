const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const HID = require('node-hid');

let mainWindow;
let debugWin = null;
let hidDevice = null;

// --- JX-11 HID ---

const JX11_BUTTONS = {
  0xcd: 'play-pause',
  0xb5: 'next-track',
  0xb6: 'prev-track',
  0xe9: 'volume-up',
  0xea: 'volume-down',
  0xe2: 'mute',
};

function findJX11() {
  const devices = HID.devices();
  return devices.find(d => d.product && d.product.includes('JX-11') && d.usagePage === 12);
}

const JX11_SCAN_INTERVAL = 3000;
const JX11_SCAN_TIMEOUT = 15000; // stop scanning after 15s
let jx11ScanStart = 0;

function broadcastHidStatus(status) {
  // status: 'connected', 'disconnected', 'scanning'
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hid-status', status);
  }
}

function connectJX11(manual = false) {
  if (hidDevice) return;

  if (manual) jx11ScanStart = Date.now();
  broadcastHidStatus('scanning');

  const info = findJX11();
  if (!info) {
    const elapsed = Date.now() - jx11ScanStart;
    if (elapsed < JX11_SCAN_TIMEOUT) {
      setTimeout(() => connectJX11(), JX11_SCAN_INTERVAL);
    } else {
      console.log('JX-11 scan timed out.');
      broadcastHidStatus('disconnected');
    }
    return;
  }

  try {
    hidDevice = new HID.HID(info.path);
    console.log('JX-11 connected!');
    broadcastHidStatus('connected');

    let prevB1 = null;
    let report1Emitted = false;

    hidDevice.on('data', (data) => {
      // Button events: Report ID 0x03 (double-click left/right, long-press bottom)
      if (data[0] === 0x03 && data[1] !== 0x00) {
        const buttonName = JX11_BUTTONS[data[1]] || `unknown-0x${data[1].toString(16)}`;
        broadcast('jx11-button', buttonName);
      }

      // Report ID 0x01: left/right single click, bottom click, wheel up/down
      // Detect on b1 transition 0x00 → non-zero (start of gesture)
      if (data[0] === 0x01) {
        if (prevB1 === 0x00 && data[1] !== 0x00 && !report1Emitted) {
          const b2 = data[2], b3 = data[3], b4 = data[4];

          if (b2 === 0xf4 && b3 === 0x01 && b4 === 0x19) {
            broadcast('jx11-button', 'bottom-click');
          } else if (b4 === 0x15) {
            broadcast('jx11-wheel', 'wheel-up');
          } else if (b4 === 0x26) {
            broadcast('jx11-wheel', 'wheel-down');
          } else if (b3 === 0x41 || (b3 & 0x0f) === 0x01) {
            broadcast('jx11-button', 'left-click');
          } else if (b3 === 0x42 || (b3 & 0x0f) === 0x02) {
            broadcast('jx11-button', 'right-click');
          } else {
            broadcast('jx11-button', `unknown-${b2.toString(16)}-${b3.toString(16)}-${b4.toString(16)}`);
          }
          report1Emitted = true;
        }

        // Reset when gesture ends (back to b1=0x00 after non-zero)
        if (data[1] === 0x00 && prevB1 !== null && prevB1 !== 0x00) {
          report1Emitted = false;
        }

        prevB1 = data[1];
      }
    });

    hidDevice.on('error', (err) => {
      console.log('JX-11 disconnected:', err.message);
      hidDevice = null;
      broadcastHidStatus('disconnected');
    });
  } catch (e) {
    console.log('Failed to open JX-11:', e.message);
    hidDevice = null;
    broadcastHidStatus('disconnected');
  }
}

function broadcast(type, key) {
  const data = { type, key };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('input-event', data);
  }
  if (debugWin && !debugWin.isDestroyed()) {
    debugWin.webContents.send('input-event', data);
  }
}

// --- Window ---

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: '울림 - Sound Board',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('renderer/index.html');

  mainWindow.on('maximize', () => mainWindow.webContents.send('window-maximized'));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-unmaximized'));
  jx11ScanStart = Date.now();
  connectJX11();
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (hidDevice) { try { hidDevice.close(); } catch {} }
  app.quit();
});

ipcMain.handle('window-minimize', () => mainWindow.minimize());
ipcMain.handle('window-maximize', () => {
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle('window-close', () => mainWindow.close());
ipcMain.handle('window-is-maximized', () => mainWindow.isMaximized());

ipcMain.handle('reconnect-hid', () => {
  if (hidDevice) { try { hidDevice.close(); } catch {} hidDevice = null; }
  connectJX11(true);
});

ipcMain.handle('open-input-debug', () => {
  if (debugWin && !debugWin.isDestroyed()) {
    debugWin.focus();
    return;
  }
  debugWin = new BrowserWindow({
    width: 700,
    height: 600,
    title: 'Input Debug',
    parent: mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  debugWin.loadFile('renderer/input-debug.html');
  debugWin.on('closed', () => { debugWin = null; });
});

ipcMain.handle('select-sound-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Sound Files',
    filters: [
      { name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'] },
    ],
    properties: ['openFile', 'multiSelections'],
  });
  return result.filePaths;
});

// --- File-based persistence ---

const dataDir = path.join(app.getPath('userData'), 'ulrim-data');

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function getDataPath(filename) {
  return path.join(dataDir, filename);
}

ipcMain.handle('save-data', (_event, filename, data) => {
  ensureDataDir();
  fs.writeFileSync(getDataPath(filename), JSON.stringify(data, null, 2), 'utf-8');
});

ipcMain.handle('load-data', (_event, filename) => {
  const filePath = getDataPath(filename);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
});
