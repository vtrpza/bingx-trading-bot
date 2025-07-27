// Load environment variables FIRST
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
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

// Middleware - Configure helmet with proper CSP for production
app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https:"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:", "fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "wss:", "ws:", "https:", "wss://open-api-ws.bingx.com"],
      fontSrc: ["'self'", "https:", "fonts.gstatic.com"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  } : false
}));
app.use(compression());
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://bingx-trading-bot-1.onrender.com',
    ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : [])
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static('public'));

// Handle favicon and manifest requests to prevent CSP errors
app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

app.get('/apple-touch-icon.png', (_req, res) => {
  res.status(204).end();
});

app.get('/manifest.json', (_req, res) => {
  res.status(204).end();
});

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    mode: process.env.DEMO_MODE === 'true' ? 'demo' : 'live'
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
    
    // Sync database models
    await sequelize.sync({ alter: true });
    logger.info('Database models synchronized');
    
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