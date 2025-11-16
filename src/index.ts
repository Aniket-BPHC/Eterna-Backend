// package.json dependencies:
// {
//   "dependencies": {
//     "express": "^4.18.2",
//     "socket.io": "^4.6.1",
//     "ioredis": "^5.3.2",
//     "axios": "^1.6.0",
//     "axios-retry": "^3.8.0",
//     "zod": "^3.22.4",
//     "bullmq": "^5.1.0"
//   },
//   "devDependencies": {
//     "@types/express": "^4.17.21",
//     "@types/node": "^20.10.0",
//     "typescript": "^5.3.3"
//   }
// }

import express, { Request, Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import Redis from 'ioredis';
import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { z } from 'zod';
import { Queue, Worker } from 'bullmq';

// ============================================================================
// TYPES & SCHEMAS
// ============================================================================

const TokenSchema = z.object({
  token_address: z.string(),
  token_name: z.string(),
  token_ticker: z.string(),
  price_sol: z.number(),
  market_cap_sol: z.number(),
  volume_sol: z.number(),
  liquidity_sol: z.number(),
  transaction_count: z.number(),
  price_1hr_change: z.number(),
  protocol: z.string(),
  last_updated: z.number(),
  source: z.string(),
});

type Token = z.infer<typeof TokenSchema>;

interface AggregatedToken extends Token {
  sources: string[];
  confidence_score: number;
}

interface PaginationParams {
  limit: number;
  cursor?: string;
  sortBy?: 'volume' | 'price_change' | 'market_cap' | 'liquidity';
  sortOrder?: 'asc' | 'desc';
  timePeriod?: '1h' | '24h' | '7d';
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  CACHE_TTL: 30, // seconds
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  PORT: process.env.PORT || 3000,
  RATE_LIMITS: {
    DEXSCREENER: { requests: 300, window: 60000 }, // 300/min
    JUPITER: { requests: 100, window: 60000 },
    GECKOTERMINAL: { requests: 30, window: 60000 },
  },
  WEBSOCKET_UPDATE_INTERVAL: 5000, // 5 seconds
  AGGREGATION_INTERVAL: 10000, // 10 seconds
};

// ============================================================================
// RATE LIMITER
// ============================================================================

class RateLimiter {
  private redis: Redis;
  private prefix: string;

  constructor(redis: Redis, prefix: string) {
    this.redis = redis;
    this.prefix = prefix;
  }

  async checkLimit(
    key: string,
    maxRequests: number,
    windowMs: number
  ): Promise<boolean> {
    const redisKey = `${this.prefix}:${key}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    const pipeline = this.redis.pipeline();
    pipeline.zremrangebyscore(redisKey, 0, windowStart);
    pipeline.zadd(redisKey, now, `${now}`);
    pipeline.zcard(redisKey);
    pipeline.expire(redisKey, Math.ceil(windowMs / 1000));

    const results = await pipeline.exec();
    const count = results?.[2]?.[1] as number;

    return count <= maxRequests;
  }

  async waitForSlot(
    key: string,
    maxRequests: number,
    windowMs: number
  ): Promise<void> {
    let attempt = 0;
    while (!(await this.checkLimit(key, maxRequests, windowMs))) {
      const backoff = Math.min(1000 * Math.pow(2, attempt), 10000);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      attempt++;
    }
  }
}

// ============================================================================
// API CLIENTS
// ============================================================================

class DexScreenerClient {
  private client: AxiosInstance;
  private rateLimiter: RateLimiter;

  constructor(rateLimiter: RateLimiter) {
    this.client = axios.create({
      baseURL: 'https://api.dexscreener.com',
      timeout: 10000,
    });

    axiosRetry(this.client, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error) => {
        return (
          axiosRetry.isNetworkOrIdempotentRequestError(error) ||
          error.response?.status === 429
        );
      },
    });

    this.rateLimiter = rateLimiter;
  }

  async searchTokens(query: string = 'SOL'): Promise<Token[]> {
    await this.rateLimiter.waitForSlot(
      'dexscreener',
      CONFIG.RATE_LIMITS.DEXSCREENER.requests,
      CONFIG.RATE_LIMITS.DEXSCREENER.window
    );

    try {
      const response = await this.client.get(`/latest/dex/search`, {
        params: { q: query },
      });

      return this.transformResponse(response.data);
    } catch (error) {
      console.error('DexScreener API error:', error);
      return [];
    }
  }

  private transformResponse(data: any): Token[] {
    const pairs = data.pairs || [];
    return pairs.slice(0, 50).map((pair: any) => ({
      token_address: pair.baseToken?.address || '',
      token_name: pair.baseToken?.name || '',
      token_ticker: pair.baseToken?.symbol || '',
      price_sol: parseFloat(pair.priceUsd || 0) / 100, // Simplified conversion
      market_cap_sol: parseFloat(pair.marketCap || 0) / 100,
      volume_sol: parseFloat(pair.volume?.h24 || 0) / 100,
      liquidity_sol: parseFloat(pair.liquidity?.usd || 0) / 100,
      transaction_count: pair.txns?.h24?.buys + pair.txns?.h24?.sells || 0,
      price_1hr_change: parseFloat(pair.priceChange?.h1 || 0),
      protocol: pair.dexId || 'Unknown',
      last_updated: Date.now(),
      source: 'dexscreener',
    }));
  }
}

class JupiterClient {
  private client: AxiosInstance;
  private rateLimiter: RateLimiter;

  constructor(rateLimiter: RateLimiter) {
    this.client = axios.create({
      baseURL: 'https://lite-api.jup.ag',
      timeout: 10000,
    });

    axiosRetry(this.client, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
    });

    this.rateLimiter = rateLimiter;
  }

  async searchTokens(query: string = 'SOL'): Promise<Token[]> {
    await this.rateLimiter.waitForSlot(
      'jupiter',
      CONFIG.RATE_LIMITS.JUPITER.requests,
      CONFIG.RATE_LIMITS.JUPITER.window
    );

    try {
      const response = await this.client.get(`/tokens/v2/search`, {
        params: { query },
      });

      return this.transformResponse(response.data);
    } catch (error) {
      console.error('Jupiter API error:', error);
      return [];
    }
  }

  private transformResponse(data: any): Token[] {
    const tokens = Array.isArray(data) ? data : [];
    return tokens.slice(0, 50).map((token: any) => ({
      token_address: token.address || '',
      token_name: token.name || '',
      token_ticker: token.symbol || '',
      price_sol: 0, // Jupiter doesn't provide price directly
      market_cap_sol: 0,
      volume_sol: 0,
      liquidity_sol: 0,
      transaction_count: 0,
      price_1hr_change: 0,
      protocol: 'Jupiter',
      last_updated: Date.now(),
      source: 'jupiter',
    }));
  }
}

// ============================================================================
// TOKEN AGGREGATOR
// ============================================================================

class TokenAggregator {
  private redis: Redis;
  private dexScreener: DexScreenerClient;
  private jupiter: JupiterClient;
  private cachePrefix = 'tokens';

  constructor(
    redis: Redis,
    dexScreener: DexScreenerClient,
    jupiter: JupiterClient
  ) {
    this.redis = redis;
    this.dexScreener = dexScreener;
    this.jupiter = jupiter;
  }

  async aggregateTokens(forceRefresh = false): Promise<AggregatedToken[]> {
    const cacheKey = `${this.cachePrefix}:aggregated`;

    // Check cache first
    if (!forceRefresh) {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    }

    // Fetch from all sources in parallel
    const [dexTokens, jupiterTokens] = await Promise.all([
      this.dexScreener.searchTokens(),
      this.jupiter.searchTokens(),
    ]);

    // Merge and deduplicate tokens
    const merged = this.mergeTokens([...dexTokens, ...jupiterTokens]);

    // Cache the results
    await this.redis.setex(
      cacheKey,
      CONFIG.CACHE_TTL,
      JSON.stringify(merged)
    );

    return merged;
  }

  private mergeTokens(tokens: Token[]): AggregatedToken[] {
    const tokenMap = new Map<string, AggregatedToken>();

    for (const token of tokens) {
      const key = token.token_address.toLowerCase();

      if (!tokenMap.has(key)) {
        tokenMap.set(key, {
          ...token,
          sources: [token.source],
          confidence_score: 1,
        });
      } else {
        const existing = tokenMap.get(key)!;

        // Merge data intelligently - prefer more recent, higher quality data
        existing.sources.push(token.source);
        existing.confidence_score = existing.sources.length;

        // Use the most recent price
        if (token.last_updated > existing.last_updated) {
          existing.price_sol = token.price_sol || existing.price_sol;
          existing.last_updated = token.last_updated;
        }

        // Aggregate volumes and liquidity
        existing.volume_sol += token.volume_sol;
        existing.liquidity_sol = Math.max(
          existing.liquidity_sol,
          token.liquidity_sol
        );
        existing.transaction_count += token.transaction_count;

        // Average price changes weighted by source count
        existing.price_1hr_change =
          (existing.price_1hr_change + token.price_1hr_change) / 2;
      }
    }

    return Array.from(tokenMap.values());
  }

  async getTokens(params: PaginationParams): Promise<{
    tokens: AggregatedToken[];
    nextCursor?: string;
  }> {
    let tokens = await this.aggregateTokens();

    // Apply sorting
    tokens = this.sortTokens(tokens, params.sortBy, params.sortOrder);

    // Apply pagination
    const startIdx = params.cursor ? parseInt(params.cursor) : 0;
    const endIdx = startIdx + params.limit;
    const paginatedTokens = tokens.slice(startIdx, endIdx);

    const nextCursor = endIdx < tokens.length ? endIdx.toString() : undefined;

    return {
      tokens: paginatedTokens,
      nextCursor,
    };
  }

  private sortTokens(
    tokens: AggregatedToken[],
    sortBy: string = 'volume',
    sortOrder: string = 'desc'
  ): AggregatedToken[] {
    const sorted = [...tokens].sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case 'volume':
          comparison = a.volume_sol - b.volume_sol;
          break;
        case 'price_change':
          comparison = a.price_1hr_change - b.price_1hr_change;
          break;
        case 'market_cap':
          comparison = a.market_cap_sol - b.market_cap_sol;
          break;
        case 'liquidity':
          comparison = a.liquidity_sol - b.liquidity_sol;
          break;
        default:
          comparison = a.volume_sol - b.volume_sol;
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return sorted;
  }
}

// ============================================================================
// WEBSOCKET MANAGER
// ============================================================================

class WebSocketManager {
  private io: SocketIOServer;
  private aggregator: TokenAggregator;
  private updateInterval: NodeJS.Timeout | null = null;

  constructor(io: SocketIOServer, aggregator: TokenAggregator) {
    this.io = io;
    this.aggregator = aggregator;
    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    this.io.on('connection', (socket) => {
      console.log('Client connected:', socket.id);

      socket.on('subscribe', async (params: PaginationParams) => {
        socket.join('token-updates');
        const { tokens } = await this.aggregator.getTokens(params);
        socket.emit('initial-data', tokens);
      });

      socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
      });
    });
  }

  startUpdates() {
    if (this.updateInterval) return;

    this.updateInterval = setInterval(async () => {
      try {
        const tokens = await this.aggregator.aggregateTokens(true);

        // Detect significant changes (>5% price change or >20% volume spike)
        const updates = tokens.filter((token) => {
          return (
            Math.abs(token.price_1hr_change) > 5 ||
            token.volume_sol > token.market_cap_sol * 0.2
          );
        });

        if (updates.length > 0) {
          this.io.to('token-updates').emit('tokens-update', updates);
        }
      } catch (error) {
        console.error('Update error:', error);
      }
    }, CONFIG.WEBSOCKET_UPDATE_INTERVAL);
  }

  stopUpdates() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }
}

// ============================================================================
// BACKGROUND JOBS
// ============================================================================

class BackgroundJobManager {
  private queue: Queue;
  private worker: Worker;
  private aggregator: TokenAggregator;

  constructor(redis: Redis, aggregator: TokenAggregator) {
    this.aggregator = aggregator;

    // Create separate Redis connections for BullMQ with correct options
    const redisOptions = {
      host: new URL(CONFIG.REDIS_URL).hostname,
      port: parseInt(new URL(CONFIG.REDIS_URL).port || '6379'),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };

    this.queue = new Queue('token-aggregation', {
      connection: redisOptions,
    });

    this.worker = new Worker(
      'token-aggregation',
      async (job) => {
        console.log('Running aggregation job...');
        await this.aggregator.aggregateTokens(true);
      },
      { connection: redisOptions }
    );

    this.worker.on('completed', (job) => {
      console.log(`Job ${job.id} completed`);
    });

    this.worker.on('failed', (job, err) => {
      console.error(`Job ${job?.id} failed:`, err);
    });
  }

  async scheduleAggregation() {
    await this.queue.add(
      'aggregate',
      {},
      {
        repeat: {
          every: CONFIG.AGGREGATION_INTERVAL,
        },
      }
    );
  }

  async close() {
    await this.queue.close();
    await this.worker.close();
  }
}

// ============================================================================
// EXPRESS SERVER
// ============================================================================

class MemeCoService {
  private app: express.Application;
  private server: any;
  private io: SocketIOServer;
  private redis: Redis;
  private aggregator: TokenAggregator;
  private wsManager: WebSocketManager;
  private jobManager: BackgroundJobManager;

  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.io = new SocketIOServer(this.server, {
      cors: { origin: '*' },
    });

    // Initialize Redis with BullMQ-compatible options
    this.redis = new Redis(CONFIG.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    // Initialize rate limiter
    const rateLimiter = new RateLimiter(this.redis, 'rate-limit');

    // Initialize API clients
    const dexScreener = new DexScreenerClient(rateLimiter);
    const jupiter = new JupiterClient(rateLimiter);

    // Initialize aggregator
    this.aggregator = new TokenAggregator(this.redis, dexScreener, jupiter);

    // Initialize WebSocket manager
    this.wsManager = new WebSocketManager(this.io, this.aggregator);

    // Initialize background jobs
    this.jobManager = new BackgroundJobManager(this.redis, this.aggregator);

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware() {
    this.app.use(express.json());

    // CORS
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      next();
    });
  }

  private setupRoutes() {
    // Health check
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: Date.now() });
    });

    // Get tokens with pagination and filtering
    this.app.get('/api/tokens', async (req: Request, res: Response) => {
      try {
        const params: PaginationParams = {
          limit: parseInt(req.query.limit as string) || 30,
          cursor: req.query.cursor as string,
          sortBy: (req.query.sortBy as any) || 'volume',
          sortOrder: (req.query.sortOrder as any) || 'desc',
          timePeriod: (req.query.timePeriod as any) || '24h',
        };

        const result = await this.aggregator.getTokens(params);

        res.json({
          success: true,
          data: result.tokens,
          pagination: {
            limit: params.limit,
            nextCursor: result.nextCursor,
          },
        });
      } catch (error) {
        console.error('Error fetching tokens:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to fetch tokens',
        });
      }
    });

    // Force refresh cache
    this.app.post('/api/tokens/refresh', async (req: Request, res: Response) => {
      try {
        const tokens = await this.aggregator.aggregateTokens(true);
        res.json({ success: true, count: tokens.length });
      } catch (error) {
        res.status(500).json({ success: false, error: 'Refresh failed' });
      }
    });
  }

  async start() {
    // Start WebSocket updates
    this.wsManager.startUpdates();

    // Schedule background aggregation
    await this.jobManager.scheduleAggregation();

    // Start server
    this.server.listen(CONFIG.PORT, () => {
      console.log(`🚀 Meme Coin Service running on port ${CONFIG.PORT}`);
      console.log(`📊 WebSocket endpoint: ws://localhost:${CONFIG.PORT}`);
      console.log(`🔄 Cache TTL: ${CONFIG.CACHE_TTL}s`);
    });
  }

  async shutdown() {
    console.log('Shutting down gracefully...');
    this.wsManager.stopUpdates();
    await this.jobManager.close();
    await this.redis.quit();
    this.server.close();
  }
}

// ============================================================================
// ENTRY POINT
// ============================================================================

const service = new MemeCoService();

service.start().catch((error) => {
  console.error('Failed to start service:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await service.shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await service.shutdown();
  process.exit(0);
});

export default service;