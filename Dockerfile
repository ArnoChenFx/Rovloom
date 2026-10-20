# 同一多架构基础清单固定到公开摘要；运行层只接收已校验的独立产品二进制。
FROM docker.io/library/buildpack-deps:bookworm-curl@sha256:a74523d7cca2436f4e3b6f5e47049d1830efbf473c33ebdf5a666f6f77425ebf
ARG VERSION
ARG COMMIT
ARG BINARY_SHA256
LABEL org.opencontainers.image.title="Rovloom" \
      org.opencontainers.image.source="https://github.com/ArnoChenFx/Rovloom" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT}" \
      io.rovloom.binary.sha256="${BINARY_SHA256}"
# 固定基础镜像已包含curl、CA和libstdc++，构建不在线安装系统包。
RUN curl --version >/dev/null \
    && groupadd --gid 10001 rovloom \
    && useradd --uid 10001 --gid 10001 --home-dir /home/rovloom --no-create-home rovloom \
    && install -d -m 0700 -o 10001 -g 10001 /home/rovloom \
       /home/rovloom/.config /home/rovloom/.config/rovloom \
       /home/rovloom/.local /home/rovloom/.local/share /home/rovloom/.local/share/rovloom
COPY --chmod=0755 dist/container/rovloom /usr/local/bin/rovloom
COPY --chmod=0755 scripts/container/healthcheck.sh /usr/local/bin/rovloom-healthcheck
RUN test -n "$BINARY_SHA256" \
    && printf '%s  /usr/local/bin/rovloom\n' "$BINARY_SHA256" | sha256sum --check --status
ENV HOME=/home/rovloom ROVLOOM_HEALTH_PORT=9444
USER 10001:10001
WORKDIR /home/rovloom
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=4s --start-period=10s --retries=3 CMD ["/usr/local/bin/rovloom-healthcheck"]
ENTRYPOINT ["/usr/local/bin/rovloom"]
CMD ["gateway"]
