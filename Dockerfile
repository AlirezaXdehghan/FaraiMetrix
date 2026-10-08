# Farai Metrix: Node runs the TypeScript sources directly (type stripping), and
# there are no runtime dependencies, so the image is just the sources.
FROM node:24.11-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY deployments ./deployments
ENV METRIX_DB=/data/metrix.sqlite METRIX_TENANTS=/config/tenants.json PORT=4000
# tenants.json is mounted at /config; its deployment paths resolve relative to
# it, so point them at the image's copies: "/app/deployments/brusato.json".
RUN mkdir /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 4000
CMD ["node", "src/main.ts"]
