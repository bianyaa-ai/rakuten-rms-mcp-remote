FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry https://registry.npmjs.org
COPY dist ./dist
ENV NODE_ENV=production
ENV PORT=8000
EXPOSE 8000
CMD ["node", "dist/index.js"]
