# FFLogs Calendar

Static GitHub Pages deployment for shared viewing.

## Admin update flow

The public page can trigger log updates only after the leader signs in with GitHub.

Required GitHub repository secrets:

- `FFLOGS_CLIENT_ID`
- `FFLOGS_CLIENT_SECRET`
- `FFLOGS_REFRESH_TOKEN`

Required Cloudflare Worker secrets:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `SESSION_SECRET`
- `GITHUB_DISPATCH_TOKEN`

The Worker dispatches `.github/workflows/update-logs.yml`, which syncs FFLogs Personal Logs, regenerates `data/calendar-data.js`, validates it, and commits generated changes.

