import { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage } from 'electron'
import { existsSync } from 'fs'
import path from 'path'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** true — выход из меню трея; иначе закрытие окна только скрывает приложение */
let appIsQuitting = false
const API_PORT = 8765

/**
 * Chromium в Electron «усыпляет» таймеры и композитор у скрытых/неактивных окон —
 * после долгого простоя UI может открыться пустым (виден только backgroundColor).
 * Отключаем тротлинг до готовности приложения.
 */
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

/** Запасная пиксельная иконка, если файл public/tray.png не найден */
const TRAY_ICON_FALLBACK = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVR42mNkGGDAgEcxYGFkZGTEYBjFUBJgYGBg+M+ABYxGw4A1YGFkBPkPAJ+lCwWf8N6nAAAAAElFTkSuQmCC',
)

function resolveTrayIconPath(): string | null {
  const candidates = [
    path.join(__dirname, '../public/tray.png'),
    path.join(__dirname, '../dist/tray.png'),
    path.join(process.cwd(), 'public/tray.png'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

function loadTrayIcon(): Electron.NativeImage {
  const file = resolveTrayIconPath()
  if (file) {
    const img = nativeImage.createFromPath(file)
    if (!img.isEmpty()) {
      if (process.platform === 'win32' || process.platform === 'linux') {
        return img.resize({ width: 32, height: 32 })
      }
      return img.resize({ width: 22, height: 22 })
    }
  }
  return TRAY_ICON_FALLBACK
}

/** Иконка окна / панели задач — та же, что и в трее, без даунскейла */
function loadAppIcon(): Electron.NativeImage {
  const file = resolveTrayIconPath()
  if (file) {
    const img = nativeImage.createFromPath(file)
    if (!img.isEmpty()) return img
  }
  return TRAY_ICON_FALLBACK
}

function showMainWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (process.platform === 'win32') {
    mainWindow.setSkipTaskbar(false)
  }
  mainWindow.show()
  mainWindow.focus()
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Открыть',
      click: () => showMainWindow(),
    },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => {
        appIsQuitting = true
        app.quit()
      },
    },
  ])
}

function createTray() {
  if (tray) return
  tray = new Tray(loadTrayIcon())
  tray.setToolTip('Predict Fun Liquidity Provider')
  tray.setContextMenu(buildTrayMenu())
  tray.on('double-click', () => showMainWindow())
}

async function waitForServer(maxRetries = 30): Promise<boolean> {
  const http = require('http')
  for (let i = 0; i < maxRetries; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${API_PORT}/api/config`, (res: any) => {
          if (res.statusCode === 200) resolve()
          else reject(new Error(`Status ${res.statusCode}`))
        })
        req.on('error', reject)
        req.setTimeout(2000, () => { req.destroy(); reject(new Error('Timeout')) })
      })
      return true
    } catch {
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  return false
}

function createWindow() {
  Menu.setApplicationMenu(null)

  mainWindow = new BrowserWindow({
    width: 1470,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#0D1117',
    titleBarStyle: 'hiddenInset',
    frame: true,
    autoHideMenuBar: true,
    icon: loadAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      /** Меньше «засыпания» вкладки в фоне — таймеры/SSE стабильнее при долгом простое */
      backgroundThrottling: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[Electron] did-fail-load', errorCode, errorDescription, validatedURL)
  })

  /** F5 / Ctrl+R — перезагрузка UI (как в браузере), если интерфейс «завис» на сером фоне. */
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const isReload =
      input.key === 'F5' ||
      (input.control && String(input.key).toLowerCase() === 'r') ||
      (input.meta && String(input.key).toLowerCase() === 'r')
    if (isReload) {
      event.preventDefault()
      mainWindow?.webContents.reload()
    }
  })

  mainWindow.on('close', (event) => {
    if (!appIsQuitting) {
      event.preventDefault()
      if (process.platform === 'win32') {
        mainWindow?.setSkipTaskbar(true)
      }
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  /**
   * После долгого hide/minimize композитор иногда не перерисовывает содержимое —
   * виден серый фон. invalidate() форсирует полный repaint.
   */
  const forceRepaint = () => {
    try {
      mainWindow?.webContents.invalidate()
    } catch {
      /* ignore */
    }
  }
  mainWindow.on('show', forceRepaint)
  mainWindow.on('restore', forceRepaint)
  mainWindow.on('focus', forceRepaint)

  /**
   * Если рендерер «завис» (длинный JS / deadlock) — сразу видно по серому экрану и неработающему F5.
   * Даём 10 сек на восстановление, иначе перезагружаем страницу.
   */
  let unresponsiveTimer: NodeJS.Timeout | null = null
  mainWindow.on('unresponsive', () => {
    console.error('[Electron] renderer is unresponsive — auto-reload in 10s if not recovered')
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer)
    unresponsiveTimer = setTimeout(() => {
      try {
        mainWindow?.webContents.reload()
      } catch {
        /* ignore */
      }
    }, 10_000)
  })
  mainWindow.on('responsive', () => {
    console.log('[Electron] renderer responsive again')
    if (unresponsiveTimer) {
      clearTimeout(unresponsiveTimer)
      unresponsiveTimer = null
    }
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Electron] render-process-gone:', details.reason, 'exitCode=', details.exitCode)
    if (details.reason === 'crashed' || details.reason === 'killed') {
      try {
        mainWindow?.reload()
      } catch {
        /* ignore */
      }
    }
  })
}

app.whenReady().then(async () => {
  /** Windows: отдельная группа на панели задач со своей иконкой (иначе кнопка наследует иконку electron.exe) */
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.rudy.predict-fun-liquidity')
  }
  /** macOS: иконка в Dock */
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(loadAppIcon())
    } catch {
      /* ignore */
    }
  }

  const ready = await waitForServer()
  if (!ready) {
    console.error(`FastAPI server not found on port ${API_PORT}`)
  } else {
    console.log('FastAPI server is ready!')
  }
  createWindow()
  createTray()

  app.on('activate', () => {
    if (mainWindow) {
      showMainWindow()
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  /** Окно «закрыто» крестиком не уничтожается (только hide) — сюда попадаем при Выходе из трея */
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

ipcMain.handle('get-api-url', () => `http://127.0.0.1:${API_PORT}`)

ipcMain.handle('open-external', async (_evt, url: string) => {
  if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
    await shell.openExternal(url)
    return { ok: true as const }
  }
  return { ok: false as const, error: 'invalid url' }
})
