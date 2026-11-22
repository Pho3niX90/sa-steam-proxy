# syntax=docker/dockerfile:1.7
# Multi-stage Rust build for sa-steam-proxy (hostNetwork /28 egress pods)
ARG RUST_IMAGE=rust:1.100-slim-bookworm

FROM ${RUST_IMAGE} AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --bin sa-steam-proxy \
 && mkdir -p /out \
 && cp target/release/sa-steam-proxy /out/sa-steam-proxy

FROM gcr.io/distroless/cc-debian12:nonroot AS runtime
ARG APP_VERSION=0.1.0
ARG GIT_SHA=unknown
ENV APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA} \
    RUST_LOG=info \
    MALLOC_ARENA_MAX=2
COPY --from=build /out/sa-steam-proxy /usr/local/bin/sa-steam-proxy
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/usr/local/bin/sa-steam-proxy"]
