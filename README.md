# belloemeglio-api

API server for the belloemeglio.it deploy pipeline. Deployed on Render.

## Endpoints

- `POST /publish` — Create Vercel project from GitHub + add custom domain + wait for deploy
- `GET /status/:slug` — Check Vercel project status
- `GET /health` — Health check

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VERCEL_TOKEN` | Yes | Vercel API token (Full Account scope) |
| `VERCEL_TEAM_ID` | Yes | Vercel team ID |
| `GITHUB_ORG` | No | GitHub org (default: fox-0101) |
| `API_KEY` | No | API key for POST /publish authentication |
| `PORT` | No | Server port (default: 3456, Render sets this automatically) |
