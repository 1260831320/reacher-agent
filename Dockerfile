FROM n8nio/n8n:2.32.6

USER root
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node db ./db
RUN mkdir -p /app/data /app/reports && chown -R node:node /app

USER node
EXPOSE 8787
ENTRYPOINT ["node"]
CMD ["src/server.mjs"]
