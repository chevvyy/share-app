# syntax=docker/dockerfile:1
# share-app: zero-dependency Node.js server. No npm install step is needed.
# For fully reproducible builds, pin the base image by digest, e.g.
#   FROM node:22-alpine@sha256:<digest>
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

# The image's built-in "node" user is UID/GID 1000. Run as that numeric UID so
# Kubernetes' runAsNonRoot check can verify it.
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000:1000

EXPOSE 8080
VOLUME ["/data"]
STOPSIGNAL SIGTERM
CMD ["node", "src/index.js"]
