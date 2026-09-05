# DexPad Desktop

DexPad is a Windows desktop shell that runs the Ideon visual workspace as a real desktop layer.

## Goal

- Run the Ideon canvas in Chromium/Electron.
- Attach the canvas to Windows' `WorkerW` layer so it lives behind desktop icons.
- Start with Windows.
- Keep DexPad in the system tray.
- Toggle desktop interaction with `Ctrl+Alt+D`.
- Keep normal workspace mode available in a regular window.

The WorkerW implementation follows the same Windows desktop-layer technique documented by DeskX: `Progman` → `0x052C` → locate the empty `WorkerW` → `SetParent` the Chromium window into that layer. DeskX documents this as the layer behind desktop icons. https://github.com/Felix-au/DeskX-Wallpaper-Engine

## Development

Requirements: Windows 10/11, Node.js 20+, Git, and pnpm/Corepack.

```powershell
npm install
npm run bootstrap:ideon
npm run dev
```

`bootstrap:ideon` clones the upstream Ideon repository into `vendor/ideon`, installs its dependencies, and builds its server.

By default DexPad starts in wallpaper mode and expects Ideon at `http://localhost:3000`. The desktop shell will automatically start the built Ideon server when it finds `vendor/ideon/dist/server.cjs`.

For faster development against an already-running Ideon instance:

```powershell
$env:IDEON_URL='http://localhost:3000'
npm run dev
```

## Controls

- **Desktop Wallpaper**: attach/detach the DexPad window from WorkerW.
- **Interactive Mode**: enable/disable input to the wallpaper canvas.
- **Ctrl+Alt+D**: toggle Interactive Mode.
- **System Tray → Settings**: change the Ideon URL and startup behavior.

## Architecture

```text
DexPad Electron
├── Normal workspace BrowserWindow
├── Desktop BrowserWindow
│   └── Win32 WorkerW attachment
├── System tray
├── Windows startup registration
└── Ideon server process
    └── vendor/ideon
```

## Important limitation

The first iteration intentionally keeps the whole desktop canvas either interactive or click-through. Selective per-card hit testing can be added later so desktop icons remain clickable while individual DexPad widgets remain interactive.

## Licensing

DexPad's shell is MIT-licensed in this repository. Ideon is an AGPL-3.0-or-later project; its source and any distributed derivative work must comply with Ideon's license. See https://github.com/3xpyth0n/ideon for the upstream license and source.
