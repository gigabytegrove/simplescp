FROM --platform=$BUILDPLATFORM golang:1.27.1-alpine AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
ARG COMMIT=unknown
WORKDIR /src
RUN apk add --no-cache ca-certificates
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN BUILDTIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" && \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build -trimpath \
    -ldflags="-s -w -X github.com/gigabytegrove/simplescp/internal/buildinfo.Version=${VERSION} -X github.com/gigabytegrove/simplescp/internal/buildinfo.Commit=${COMMIT} -X github.com/gigabytegrove/simplescp/internal/buildinfo.BuildTime=${BUILDTIME}" \
    -o /out/simplescp ./cmd/simplescp

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata && addgroup -S simplescp && adduser -S -G simplescp -u 10001 simplescp
WORKDIR /app
COPY --from=build /out/simplescp /app/simplescp
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod 0755 /app/docker-entrypoint.sh && mkdir -p /data/update && chown -R simplescp:simplescp /data /app
USER simplescp
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["/app/docker-entrypoint.sh"]
