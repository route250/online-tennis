# Repository Guidelines (Updated)

## Project Structure & Module Organization
- `client/index.html`: Lobby and game UI shell (mobile-friendly)
- `client/app.js`: Client logic (WebSocket, rendering, input, QR fetch)
- `client/styles.css`: Client styles (responsive, touch tweaks)
- `server/index.js`: Authoritative game server (Express + ws) at `/ws`; serves `client/`
- `bin/start-server.sh`, `bin/server.sh`: Startup scripts (port/host options)
- `tests/*.js`: Diagnostics (`test_lobby.js`, `test_integration.js`)
- `logs/`: Local logs (ignored by git)
- `spec.md`, `tickets.md`, `todo.md`: Design, planning, and tasks

## Build, Test, and Development Commands
- Install: `npm install`
- Run server: `bin/start-server.sh` (default port 3000). Options:
  - `bin/start-server.sh -p 4000` or `PORT=4000 bin/start-server.sh`
  - Advanced: `bin/server.sh --local|--public -p <PORT>` (bind host selection)
- Static preview only: `npm start` (serves `client/` only; no WebSocket)
- Smoke test (lobby): `node tests/test_lobby.js` (requires server running)
- Integration test: `node tests/test_integration.js` (simulates two players)

## Coding Style & Naming Conventions
- Language: JavaScript (Node/Browser). Indent 2 spaces; include semicolons.
- Strings: prefer single quotes; variables/functions in `camelCase`.
- Files: lowercase with hyphens or `index.js` pattern under folders.
- WS message types: UPPER_SNAKE (e.g., `GAME_STATE`, `CONNECT_ACK`).
- Keep modules small and focused; avoid global state except server maps.

## Testing Guidelines
- No formal test runner; keep diagnostics in `tests/` with clear console output and exit codes.
- Add new diagnostics as `tests/test_*.js`.
- Manual checks: run server, open two browsers (or phone via QR), verify lobby join, invite/accept, serve-on-release, scoring, mirrored perspective.

## Commit & Pull Request Guidelines
- Commits: imperative, present tense; concise scope first. Example: `feat(server): add serve speed clamp`.
- PRs: include summary, rationale, reproduction steps, and risks. Attach logs or screenshots/GIFs of lobby and gameplay. Link related items in `spec.md`/`tickets.md`.
- Required: confirm `bin/start-server.sh` runs, and both `node tests/test_lobby.js` and `node tests/test_integration.js` pass locally.

## Security & Configuration Tips
- Prototype is LAN-focused; no auth. Avoid exposing publicly.
- Configure port via `PORT` or `-p`. Bind host via `HOST` or `bin/server.sh --local|--public`.
- WebSocket path is `/ws`; keep same-origin in development.
- QR/URL endpoints: `GET /server-info` (host/port info), `GET /qr.svg?url=...`（server uses `qrcode`）. See `spec.md`.
