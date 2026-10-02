# syntax=docker/dockerfile:1.7

FROM golang:1.27.1-alpine AS build
WORKDIR /src
RUN apk add --no-cache ca-certificates
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/simplescp ./cmd/simplescp

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata && addgroup -S simplescp && adduser -S -G simplescp -u 10001 simplescp
WORKDIR /app
COPY --from=build /out/simplescp /app/simplescp
RUN mkdir -p /data && chown -R simplescp:simplescp /data /app
USER simplescp
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["/app/simplescp"]
