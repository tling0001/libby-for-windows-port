# Libby Windows Port — v10

This build intentionally starts from the original `LibbyWindowsPort.zip` architecture, which was the last version that reached Libby's update/version screen, instead of carrying forward the later experimental bridge changes.

Key differences:
- Android 9.5.0 bridge contract copied from the supplied Android source.
- `BRIDGE.capabilities()` and `BRIDGE.environment()` are synchronous.
- Exact Android capability resource is used as the base.
- User-Agent uses `(Dewey; V32; Android; 9.5.0; RELEASE)`.
- Chromium HTTP cache is cleared before the initial load, like `ip1.loadUrl()`.
- No artificial Libby host allow-list.
- Persistent cookies/local storage/IndexedDB remain intact.
- ZIP is the only Windows distribution target; no portable self-extracting EXE.
