import { app, BrowserWindow, ipcMain, shell } from 'electron'
import * as path from 'path'
import { initDb } from './db/index'
import { registerAllHandlers } from './ipc/index'
import { getOrphanedRuns, updateRun } from './db/queries/runs'
import { deleteWorkspace } from './execution/workspace'
import { deleteMcpConfig } from './utils/mcp'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset', // macOS: traffic lights overlay
    backgroundColor: '#0d0d0d',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // Load the renderer
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(async () => {
  // Initialize the database (creates tables if not present)
  initDb()

  // Clean up orphaned 'running' runs left over from a crashed session
  const orphaned = getOrphanedRuns()
  for (const run of orphaned) {
    if (run.workspacePath) deleteWorkspace(run.workspacePath)
    deleteMcpConfig(run.id)
    updateRun(run.id, { status: 'failed', endedAt: Date.now() })
  }

  const mainWindow = createWindow()
  registerAllHandlers(mainWindow)

  // Allow renderer to open external URLs via shell
  ipcMain.handle('shell:openExternal', (_event, url: string) => {
    return shell.openExternal(url)
  })

  app.on('activate', () => {
    // On macOS re-create a window when the dock icon is clicked and no windows are open
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // On macOS apps conventionally stay active until the user quits explicitly
  if (process.platform !== 'darwin') app.quit()
})
