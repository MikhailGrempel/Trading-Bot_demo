# Zero-dependency app: a bare Node runtime is all that's needed.
FROM node:20-alpine

WORKDIR /app
COPY . .

EXPOSE 4000
ENV PORT=4000

# No `npm install` — the project intentionally has no third-party deps.
CMD ["node", "server/index.js"]
