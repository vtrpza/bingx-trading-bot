import { Sequelize } from 'sequelize';
import { logger } from '../utils/logger';

// Use SQLite for development if PostgreSQL is not available
const isDevelopment = process.env.NODE_ENV !== 'production';
const databaseUrl = process.env.DATABASE_URL;

let sequelize: Sequelize;

if (databaseUrl && databaseUrl.includes('postgresql')) {
  // PostgreSQL configuration
  sequelize = new Sequelize(databaseUrl, {
    dialect: 'postgres',
    logging: (msg) => logger.debug(msg),
    pool: {
      max: 5,
      min: 0,
      acquire: 30000,
      idle: 10000
    },
    dialectOptions: {
      ssl: process.env.NODE_ENV === 'production' ? {
        require: true,
        rejectUnauthorized: false
      } : false
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

export { sequelize };