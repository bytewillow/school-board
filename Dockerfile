# 构建：前端打包 + 服务端编译
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build && npm prune --omit=dev

# 运行：只带运行依赖和构建产物
FROM node:24-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=8765 WEB_DIR=/app/dist/web TZ=Asia/Shanghai
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
VOLUME /data
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8765)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings=ExperimentalWarning", "dist/server/server/index.js"]
