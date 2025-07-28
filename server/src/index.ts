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

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3001;

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
    'https://bingx-trading-bot-1.onrender.com',
    'https://bingx-trading-bot-lu0z-frontend.onrender.com',
    'https://bingx-trading-bot-lu0z-frontend-rjhj.onrender.com',
    ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : [])
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Accept', 'Accept-Encoding']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    mode: process.env.DEMO_MODE === 'true' ? 'demo' : 'live',
    websocket: 'enabled',
    protocol: 'ws/wss'
  });
});

// Root endpoint for API service
app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'BingX Trading Bot API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      api: '/api/*',
      assets: '/api/assets',
      trading: '/api/trading', 
      marketData: '/api/market-data'
    }
  });
});

// API Routes
app.use('/api/assets', assetsRouter);
app.use('/api/trading', tradingRouter);
app.use('/api/market-data', marketDataRouter);

// Error handling middleware
app.use(errorHandler);

// Initialize WebSocket
setupWebSocket(server);

// Initialize database and start server
async function startServer() {
  try {
    // Test database connection
    await sequelize.authenticate();
    logger.info('Database connection established successfully');
    
    // Migration should be handled by separate migration script before server starts
    // This avoids conflicts and ensures proper database setup
    logger.info('Database models will be managed by migration scripts');
    
    // Start the server
    server.listen(PORT, () => {
      logger.info(`Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
      
      // Start trading bot if enabled
      if (process.env.AUTO_START_BOT === 'true') {
        startTradingBot();
      }
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
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
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
  });
  await sequelize.close();
  process.exit(0);
});

startServer();