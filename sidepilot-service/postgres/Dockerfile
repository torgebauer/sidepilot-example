FROM ghcr.io/cloudnative-pg/postgresql:16
USER root
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-16-pgvector; \
    rm -rf /var/lib/apt/lists/*
USER 26
