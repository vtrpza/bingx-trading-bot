import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { setupWebSocket } from './services/websocket';
import { errorHandler } from './utils/errorHandler';
import { logger } from './utils/logger';
import assetsRouter from './api/assets';
import tradingRouter from './api/trading';
import marketDataRouter from './api/marketData';
import { sequelize } from './config/database';
import { startTradingBot } from './trading/bot';

// Load environment variables
dotenv.config();

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.FRONTEND_URL 
    : 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
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