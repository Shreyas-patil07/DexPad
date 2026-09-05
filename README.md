# DexPad Desktop

DexPad is a standalone local Windows desktop workspace.

It runs entirely on the user's computer. There is no account system, no cloud backend, and no external workspace service.

## Features

- Local notes, todos, and links.
- Drag cards around the desktop workspace.
- Persistent local storage through Electron Store.
- Optional Windows desktop-wallpaper mode.
- System tray utility.
- Start with Windows.
- `Ctrl + Alt + D` opens the editable DexPad workspace.
- External links open through the normal system browser.

## Development

Requirements: Windows 10/11 and Node.js 20+.

```powershell
npm install
npm run dev
```

Build the Windows application with:

```powershell
npm run build
```

## Architecture

```text
DexPad Electron
├── Local workspace BrowserWindow
│   └── Notes / Todos / Links
├── Desktop BrowserWindow
│   └── Win32 WorkerW attachment
├── Local persistence
│   └── electron-store
├── System tray
└── Windows startup registration
```

## Wallpaper mode

Wallpaper mode places a read-only copy of the saved workspace behind the Windows desktop icons using the native `WorkerW` desktop layer. Because that layer is intentionally click-through, editing is performed in the normal DexPad workspace window and then saved locally.

## Privacy

Workspace data is stored locally by DexPad. The application does not require an account or a remote service to operate.

## License

MIT
