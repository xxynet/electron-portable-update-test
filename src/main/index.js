'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createUpdateCheckService } = require('./update-check-service');

let mainWindow = null;
let backend = null;
let updateService = null;

function readBuildInfo() {
  const location = app.isPackaged
    ? path.join(process.resourcesPath, 'build-info.json')
    : path.join(__dirname, '..', '..', 'resources', 'build-info.json');
  try { return JSON.parse(fs.readFileSync(location, 'utf8')); } catch (_) {
    return { version: app.getVersion(), flavor: 'Unknown build', accent: '#5b8cff' };
  }
}

function startBackend() {
  const backendDir = app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.join(__dirname, '..', '..', 'backend');
  const python = process.env.PORTABLE_TEST_PYTHON || 'python';
  backend = spawn(python, ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', '8765'], {
    cwd: backendDir,
    windowsHide: true,
    env: {
      ...process.env,
      PORTABLE_TEST_RESOURCE_DIR: app.isPackaged
        ? process.resourcesPath
        : path.join(__dirname, '..', '..', 'resources'),
    },
    stdio: 'ignore',
  });
  backend.once('error', () => { backend = null; });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  startBackend();
  createWindow();
  updateService = createUpdateCheckService({
    app,
    dialog,
    shell,
    log: (...values) => console.log(...values),
    onStatusChange: (status) => mainWindow?.webContents.send('update-status', status),
  });
  ipcMain.handle('build-info', () => ({ appVersion: app.getVersion(), ...readBuildInfo() }));
  ipcMain.handle('backend-status', async () => {
    try {
      const response = await fetch('http://127.0.0.1:8765/api/status');
      return await response.json();
    } catch (_) { return { backend: 'FastAPI unavailable' }; }
  });
  ipcMain.handle('check-update', () => updateService.checkNow());
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { try { backend?.kill(); } catch (_) {} });
