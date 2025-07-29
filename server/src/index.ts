// Load environment variables FIRST
import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { createServer } from 'http';
import { setupWebSocket } from './services/websocket';
import { errorHandler } from './utils/errorHandler';
import { logger } from './utils/logger';
import assetsRouter from './api/assets';
import tradingRouter from './api/trading';
import marketDataRouter from './api/marketData';
import { sequelize } from './config/database';
import { startTradingBot } from './trading/bot';
import { validateEnvironment } from './utils/envCheck';

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3001;

// Validate environment on startup
const envCheck = validateEnvironment();
// Environment validation now logs its own status messages

// Middleware - Configure helmet with relaxed CSP
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https:"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:", "fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "wss:", "ws:", "https:", "wss://open-api-ws.bingx.com", "wss://*.onrender.com", "ws://*.onrender.com"],
      fontSrc: ["'self'", "https:", "fonts.gstatic.com"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  }
}));
app.use(compression());
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://bingx-trading-bot-lu0z-frontend.onrender.com',
    ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : [])
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Accept', 'Accept-Encoding']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Comprehensive request logging middleware
app.use((req: Request, res: Response, next) => {
  const start = Date.now();
  const requestId = Math.random().toString(36).substring(7);
  
  logger.info(`🔗 [${requestId}] ${req.method} ${req.url}`, {
    method: req.method,
    url: req.url,
    headers: {
      origin: req.headers.origin,
      'user-agent': req.headers['user-agent'],
      'x-forwarded-for': req.headers['x-forwarded-for'],
      host: req.headers.host
    },
    query: req.query,
    body: req.method !== 'GET' ? req.body : undefined
  });

  // Track response
  res.on('finish', () => {
    const duration = Date.now() - start;
    const statusColor = res.statusCode >= 400 ? '🔴' : res.statusCode >= 300 ? '🟡' : '🟢';
    
    logger.info(`${statusColor} [${requestId}] ${res.statusCode} ${req.method} ${req.url} (${duration}ms)`, {
      statusCode: res.statusCode,
      duration,
      method: req.method,
      url: req.url
    });
  });

  next();
});

// Serve static files
app.use(express.static('public'));

// Handle favicon and manifest requests with proper headers
app.get('/favicon.ico', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'image/x-icon');
  res.status(204).end();
});

app.get('/apple-touch-icon.png', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'image/png');
  res.status(204).end();
});

app.get('/manifest.json', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/json');
  res.status(204).end();
});

// Health check endpoint with database verification
app.get('/health', async (_req: Request, res: Response) => {
  let dbStatus = 'unknown';
  let dbError = null;
  
  try {
    // Test database connection with timeout
    await Promise.race([
      sequelize.authenticate(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Database timeout')), 5000)
      )
    ]);
    dbStatus = 'connected';
  } catch (error) {
    dbStatus = 'disconnected';
    dbError = error instanceof Error ? error.message : 'Unknown error';
  }
  
  // Always return 200 for health checks to keep service alive
  const health = {
    status: 'healthy', // Always healthy if server is responding
    timestamp: new Date().toISOString(),
    mode: process.env.DEMO_MODE === 'true' ? 'demo' : 'live',
    websocket: 'enabled',
    protocol: 'ws/wss',
    database: dbStatus,
    environment: process.env.NODE_ENV,
    services: {
      api: 'operational',
      websocket: 'operational',
      database: dbStatus,
      trading: process.env.AUTO_START_BOT === 'true' ? 'enabled' : 'disabled'
    },
    version: '1.0.0',
    uptime: process.uptime(),
    ...(dbError && { databaseError: dbError })
  };
  
  res.status(200).json(health);
});

// Root endpoint for API service
app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'BingX Trading Bot API',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      test: '/test',
      api: '/api/*',
      assets: '/api/assets',
      trading: '/api/trading', 
      marketData: '/api/market-data'
    }
  });
});

// Simple test endpoint to verify routing
app.get('/test', (_req: Request, res: Response) => {
  logger.info('✅ Test endpoint hit successfully');
  res.json({
    message: 'Backend is working!',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    mode: process.env.DEMO_MODE === 'true' ? 'demo' : 'live'
  });
});

// Test API endpoint
app.get('/api/test', (_req: Request, res: Response) => {
  logger.info('✅ API test endpoint hit successfully');
  res.json({
    message: 'API routing is working!',
    timestamp: new Date().toISOString(),
    path: '/api/test'
  });
});

// API Routes with error logging
app.use('/api/assets', (req, _res, next) => {
  logger.info(`🔄 Assets API request: ${req.method} ${req.url}`);
  next();
}, assetsRouter);

app.use('/api/trading', (req, _res, next) => {
  logger.info(`🔄 Trading API request: ${req.method} ${req.url}`);
  next();
}, tradingRouter);

app.use('/api/market-data', (req, _res, next) => {
  logger.info(`🔄 Market Data API request: ${req.method} ${req.url}`);
  next();
}, marketDataRouter);

// Catch-all for unmatched API routes
app.use('/api/*', (req: Request, res: Response) => {
  logger.warn(`❌ Unmatched API route: ${req.method} ${req.url}`);
  res.status(404).json({
    error: 'API endpoint not found',
    method: req.method,
    url: req.url,
    availableRoutes: [
      '/api/assets',
      '/api/trading',
      '/api/market-data'
    ]
  });
});

// Error handling middleware
app.use(errorHandler);

// Initialize WebSocket
setupWebSocket(server);

// Initialize database and start server
async function startServer() {
  const port = parseInt(PORT as string, 10) || 3001;
  
  // Start the server first - bind to 0.0.0.0 for Render
  server.listen(port, '0.0.0.0', () => {
    logger.info(`Server running on 0.0.0.0:${port} in ${process.env.NODE_ENV} mode`);
    
    // Initialize database connection after server starts
    initializeDatabase();
    
    // Start trading bot if enabled (only after database is ready)
    if (process.env.AUTO_START_BOT === 'true') {
      setTimeout(() => {
        startTradingBot();
      }, 5000); // Wait 5 seconds for database to be ready
    }
  });
}

// Separate database initialization function
async function initializeDatabase() {
  const maxRetries = 5;
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    try {
      logger.info(`Database connection attempt ${retryCount + 1}/${maxRetries}`);
      await sequelize.authenticate();
      logger.info('Database connection established successfully');
      
      // Run migrations programmatically
      try {
        logger.info('Running database migrations...');
        const { runRenderDeployMigration } = await import('./migrations/render-deploy-migrate');
        const result = await runRenderDeployMigration();
        logger.info('Database migrations completed:', result);
      } catch (migrationError) {
        logger.warn('Migration warning (non-critical):', migrationError);
        // Continue without failing - migrations might be already applied
      }
      
      return; // Success - exit retry loop
    } catch (error) {
      retryCount++;
      logger.warn(`Database connection failed (attempt ${retryCount}/${maxRetries}):`, error);
      
      if (retryCount >= maxRetries) {
        logger.error('❌ Failed to connect to database after maximum retries');
        logger.warn('⚠️  Server will continue running with limited functionality');
        return; // Don't crash the server - just log the issue
      }
      
      // Wait before retrying (exponential backoff)
      const delay = Math.pow(2, retryCount) * 1000; // 2s, 4s, 8s, 16s, 32s
      logger.info(`Retrying database connection in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  logger.error('Unhandled Rejection at:', {
    promise: promise.toString(),
    reason: reason instanceof Error ? {
      message: reason.message,
      stack: reason.stack,
      name: reason.name
    } : reason
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught Exception:', {
    message: error.message,
    stack: error.stack,
    name: error.name
  });
  // In production, you might want to exit gracefully
  // process.exit(1);
});

// Handle graceful shutdown
const gracefulShutdown = (signal: string) => {
  logger.info(`${signal} received, shutting down gracefully`);
  
  // Stop accepting new connections
  server.close(async () => {
    logger.info('HTTP server closed');
    
    try {
      // Close database connections
      await sequelize.close();
      logger.info('Database connections closed');
      
      // Close any active WebSocket connections
      const io = (global as any).io;
      if (io) {
        io.close(() => {
          logger.info('WebSocket server closed');
        });
      }
      
      process.exit(0);
    } catch (error) {
      logger.error('Error during graceful shutdown:', error);
      process.exit(1);
    }
  });
  
  // Force close after 25 seconds (Render's timeout is 30s)
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 25000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startServer();