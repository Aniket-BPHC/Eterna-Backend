# Meme Coin Aggregation Service

Real-time token data aggregation from DexScreener and Jupiter APIs with caching and WebSocket updates.

## Features

- Multi-source data aggregation (DexScreener, Jupiter)
- Redis caching (30s TTL)
- Rate limiting with exponential backoff
- WebSocket real-time updates
- RESTful API with pagination

## Prerequisites

- Node.js 18+
- Redis 7+

## Installation

```bash
# Install dependencies
npm install

# Start Redis
redis-server

# Run the service
npm run dev
```

## Docker

```bash
docker-compose up -d
```

## API Endpoints

### Get Tokens
```bash
GET /api/tokens?limit=20&sortBy=volume&sortOrder=desc
```

### Force Refresh
```bash
POST /api/tokens/refresh
```

### Health Check
```bash
GET /health
```

## Configuration

Edit `CONFIG` in `src/index.ts`:

```typescript
const CONFIG = {
  CACHE_TTL: 30,                    // seconds
  PORT: 3000,
  WEBSOCKET_UPDATE_INTERVAL: 5000,  // milliseconds
  AGGREGATION_INTERVAL: 10000,      // milliseconds
};
```

## WebSocket

```javascript
const socket = io('http://localhost:3000');

socket.emit('subscribe', { limit: 20 });

socket.on('initial-data', (tokens) => {
  console.log(tokens);
});

socket.on('tokens-update', (updates) => {
  console.log(updates);
});
```

## License

MIT
