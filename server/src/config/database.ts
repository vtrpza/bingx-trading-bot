import { Sequelize } from 'sequelize';
import { logger } from '../utils/logger';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://localhost:5432/bingx_trading_bot';

export const sequelize = new Sequelize(databaseUrl, {
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