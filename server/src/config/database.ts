import { Sequelize } from 'sequelize';
import { logger } from '../utils/logger';

// Use SQLite for development if PostgreSQL is not available
const isDevelopment = process.env.NODE_ENV !== 'production';
const databaseUrl = process.env.DATABASE_URL;

let sequelize: Sequelize;

if (databaseUrl && databaseUrl.includes('postgresql')) {
  // PostgreSQL configuration with enhanced retry logic for Render
  sequelize = new Sequelize(databaseUrl, {
    dialect: 'postgres',
    logging: isDevelopment ? (msg) => logger.debug(msg) : false,
    pool: {
      max: 10,          // Increased for Render
      min: 2,           // Minimum connections
      acquire: 60000,   // Increased timeout for Render
      idle: 10000,
      evict: 1000
    },
    dialectOptions: {
      ssl: process.env.NODE_ENV === 'production' ? {
        require: true,
        rejectUnauthorized: false
      } : false,
      // Add connection timeout
      connectTimeout: 60000,
      // Add statement timeout
      statement_timeout: 30000,
      query_timeout: 30000
    },
    // Retry configuration for connection failures
    retry: {
      max: 3,
      match: [
        /ETIMEDOUT/,
        /EHOSTUNREACH/,
        /ECONNRESET/,
        /ECONNREFUSED/,
        /ENOTFOUND/,
        /ENETUNREACH/,
        /EAI_AGAIN/,
        /SequelizeConnectionError/,
        /SequelizeConnectionRefusedError/,
        /SequelizeHostNotFoundError/,
        /SequelizeHostNotReachableError/,
        /SequelizeInvalidConnectionError/,
        /SequelizeConnectionTimedOutError/
      ]
    },
    // Define hooks for connection monitoring
    hooks: {
      beforeConnect: async () => {
        logger.info('Attempting to connect to PostgreSQL database...');
      },
      afterConnect: async () => {
        logger.info('Successfully connected to PostgreSQL database');
      }
    }
  });
} else {
  // SQLite fallback for development
  logger.warn('PostgreSQL not configured, using SQLite for development');
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: isDevelopment ? 'database.sqlite' : ':memory:',
    logging: (msg) => logger.debug(msg),
  });
}

// Migration will be handled separately via production-migrate.ts
// This prevents conflicts with proper migration scripts
logger.debug('Database configuration loaded, migrations will be handled by migration scripts');

export { sequelize };