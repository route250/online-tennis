# Repository Guidelines

## Project Structure & Module Organization
- `index.html`: Lobby and game UI shell.
- `src/app.js`: Client logic (WebSocket, rendering, input).
- `server/index.js`: Authoritative game server (Express + ws) at `/ws`.
- `scripts/*.js`: Diagnostic tests (`test_lobby.js`, `test_integration.js`).
- `logs/`: Local logs (if enabled); safe to ignore.
- `spec.md`, `tickets.md`, `todo.md`: Design, planning, and tasks.

## Build, Test, and Development Commands
- Install: `npm install`
- Run server: `node server/index.js` (use `PORT=3000` to override)
- Static preview only: `npm start` (no WebSocket server; not for gameplay)
- Smoke test (lobby): `node scripts/test_lobby.js` (requires server running)
- Integration test: `node scripts/test_integration.js` (simulates two players)

## Coding Style & Naming Conventions
- Language: JavaScript (Node/Browser). Indent 2 spaces; include semicolons.
- Strings: prefer single quotes; variables/functions in `camelCase`.
- Files: lowercase with hyphens or `index.js` pattern under folders.
- WS message types: UPPER_SNAKE (e.g., `GAME_STATE`, `CONNECT_ACK`).
- Keep modules small and focused; avoid global state except server maps.

## Testing Guidelines
- No formal test runner; use scripts under `scripts/` for smoke/integration.
- Add new diagnostics as `scripts/test_*.js` with clear console output and exit codes.
- Manual checks: run server, open two browsers, verify serve/start, scoring, and mirrored perspective.

## Commit & Pull Request Guidelines
- Commits: imperative, present tense; concise scope first. Example: `feat(server): add serve speed clamp`.
- PRs: include summary, rationale, reproduction steps, and risks. Attach logs or screenshots/GIFs of lobby and gameplay. Link related items in `spec.md`/`tickets.md`.
- Required: confirm `node server/index.js` runs, and both `scripts/test_lobby.js` and `scripts/test_integration.js` pass locally.

## Security & Configuration Tips
- Prototype is LAN-focused; no auth. Avoid exposing publicly.
- Configure port via `PORT`. WebSocket path is `/ws`; keep same-origin in development.
