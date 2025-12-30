# Helm Poll

Helm Poll is a desktop governance application (Tauri) that provides an interface to a local or community Exchange.

- **Personal Mode:** runs a local Exchange on your device (default)
- **Community Mode:** connects to a shared Exchange run by your group (may be limited in early versions)

## Status
Early scaffold. The Exchange behavior is governed by the contract in `/contracts/`.

## Repo Layout
- `/app` — desktop app UI (Tauri)
- `/exchange` — Exchange service (poll lifecycle, cooling-off, overrides)
- `/shared` — shared schemas and types (polls, votes, overrides)
- `/contracts` — binding system contracts (Exchange contract lives here)
- `/docs` — documentation for humans to read
- `/scripts` — helper scripts

## License
MIT (see LICENSE)
