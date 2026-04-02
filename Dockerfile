# ── Stage 1: Build frontend (arch-independent static files) ──────────
FROM --platform=$BUILDPLATFORM node:20-alpine AS frontend
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --production=false
COPY web/ ./
RUN npm run build

# ── Stage 2: Build backend (native cross-compilation, no QEMU) ──────
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS backend
ARG TARGETARCH
RUN apk add --no-cache git
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/server/ ./cmd/server/
RUN CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build -ldflags="-s -w" -o kube-argus ./cmd/server

# ── Stage 3: Final image ────────────────────────────────────────────
FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=backend /app/kube-argus .
COPY --from=frontend /app/web/dist ./web/dist

EXPOSE 8080
USER nobody
ENTRYPOINT ["./kube-argus"]
