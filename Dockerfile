# ── Stage 1: Build frontend ──────────────────────────────────────────
FROM node:18-alpine AS frontend
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --production=false
COPY web/ ./
RUN npm run build

# ── Stage 2: Build backend ──────────────────────────────────────────
FROM golang:1.19-alpine AS backend
RUN apk add --no-cache git
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o k8sdash main.go

# ── Stage 3: Final image ────────────────────────────────────────────
FROM alpine:3.19
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=backend /app/k8sdash .
COPY --from=frontend /app/web/dist ./web/dist

EXPOSE 8080
ENTRYPOINT ["./k8sdash"]
