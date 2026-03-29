# Contributing to K8SDASH

Thanks for your interest in contributing! This document covers everything you need to get started.

## Development Setup

### Prerequisites

- Go 1.19+
- Node.js 18+ and npm
- Access to a Kubernetes cluster (local or remote)
- (Optional) Prometheus for metrics features
- (Optional) Google OAuth credentials or an OIDC provider for auth testing

### Running Locally

```bash
# 1. Install frontend dependencies
cd web && npm install && cd ..

# 2. Start the frontend dev server (hot-reload on :5173)
cd web && npm run dev &

# 3. Start the Go backend (serves API on :8080)
go run main.go
```

The Vite dev server proxies `/api` and `/auth` to `localhost:8080`, so open http://localhost:5173 for development with hot reload.

### Building for Production

```bash
cd web && npm run build && cd ..
go build -o k8sdash main.go
./k8sdash
```

The Go binary serves the built frontend from `web/dist/`.

## Making Changes

### Backend (Go)

The entire backend is in `main.go`. Key sections:

- **Auth**: OIDC/OAuth2 flow, session management
- **Cache**: In-memory K8s resource cache, refreshed every 15s
- **API handlers**: REST endpoints under `/api/`
- **Prometheus**: Metric queries and aggregation
- **AI**: LLM integration for pod diagnosis
- **Spot Advisor**: AWS spot pricing and recommendations

### Frontend (React/TypeScript)

The frontend is a single-page app in `web/src/App.tsx`:

- All components are in one file for simplicity
- Tailwind CSS for styling (dark theme)
- Recharts for metric graphs
- xterm.js for terminal/exec

### Code Style

- **Go**: Standard `gofmt` formatting
- **TypeScript**: ESLint config included (`npm run lint`)
- No comments that just narrate what the code does
- Keep the single-file architecture for both frontend and backend

## Pull Requests

1. Fork the repo and create a feature branch from `main`
2. Make your changes with clear, descriptive commits
3. Ensure `go build` and `npm run build` succeed
4. Test your changes against a real cluster if possible
5. Open a PR with a description of what and why

## Reporting Issues

- Use GitHub Issues for bugs and feature requests
- Include browser console output and backend logs for bug reports
- For security issues, see [SECURITY.md](SECURITY.md)

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
