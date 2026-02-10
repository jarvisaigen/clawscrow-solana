FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3051
CMD ["npx", "tsx", "backend/server.ts"]
