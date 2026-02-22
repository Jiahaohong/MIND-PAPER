Place Qdrant binaries here for packaged auto-start.

Expected layout:

- `resources/qdrant/qdrant-macos`
- `resources/qdrant/qdrant-win.exe`
- `resources/qdrant/qdrant-linux`

The app will try these locations in order:

1. `MINDPAPER_QDRANT_BIN` (env override)
2. Packaged resources: `Resources/qdrant/<platform-binary>`
3. Dev resources: `resources/qdrant/<platform-binary>`
4. System command: `qdrant`
