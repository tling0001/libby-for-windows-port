# Libby Windows Port

This project ports the supplied **Libby Android 9.5.0 shell** to Windows as a native Electron desktop application.

## What is preserved

- The real Libby web client at `https://libbyapp.com`
- Persistent cookies, local storage, IndexedDB and login state
- Libby's web UI and library/search/borrowing/reading experience
- The Android shell's `BRIDGE.capabilities()`, `BRIDGE.environment()` and `BRIDGE.clientToShellAsJSON()` compatibility surface
- Native downloads into `%USERPROFILE%\\Downloads\\Libby`
- Windows notifications for completed downloads and scheduled notifier messages
- Geolocation and notification permission handling
- External links opened in the Windows default browser
- Print and PDF export
- Persistent desktop window/session state through Electron's persistent partition
- Windows media-key forwarding hooks
- Dark-mode information exposed to the platform-traits bridge
- Passkey support through Chromium/WebAuthn where supported by Windows

## Important limitation

The supplied Android project is primarily a shell around Libby's web application. Android-specific services such as Android Auto, Android app widgets, Android foreground-service lifecycle, Android haptics, and Google Play-specific plumbing do not have one-to-one Windows equivalents. The port replaces those with Windows-native equivalents where practical instead of pretending those Android APIs exist on Windows.

## Build on Windows

Install Node.js 20+ and run:

```powershell
npm install
npm run start
```

Create the Windows ZIP distribution (no self-extracting portable EXE):

```powershell
npm run dist
```

The output is a ZIP containing the Windows application files. Extract the ZIP to a folder and run the Libby executable from that folder. This avoids the portable target's self-extraction delay.

## Architecture

`src/main.js` is the Windows host. `src/preload.js` provides the compatibility bridge to the Libby web client. Electron's persistent session provides the browser storage layer.
