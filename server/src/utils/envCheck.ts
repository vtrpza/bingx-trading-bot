/**
 * Environment validation for production deployment
 */
import { logger } from './logger';

export function validateEnvironment(): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  let valid = true;

  // Critical environment variables
  const critical = [
    'NODE_ENV',
    'DATABASE_URL'
  ];

  // Optional but recommended
  const optional = [
    'BINGX_API_KEY',
    'BINGX_SECRET_KEY',
    'FRONTEND_URL'
  ];

  // Check critical variables
  for (const envVar of critical) {
    if (!process.env[envVar]) {
      logger.error(`❌ Missing critical environment variable: ${envVar}`);
      valid = false;
    } else {
      logger.info(`✅ ${envVar} is configured`);
    }
  }

  // Check optional variables
  for (const envVar of optional) {
    if (!process.env[envVar]) {
      warnings.push(`⚠️  Optional environment variable missing: ${envVar}`);
    } else {
      logger.info(`✅ ${envVar} is configured`);
    }
  }

  // Log warnings
  warnings.forEach(warning => logger.warn(warning));

  // Environment summary
  logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`🎯 Demo Mode: ${process.env.DEMO_MODE === 'true' ? 'enabled' : 'disabled'}`);
  logger.info(`🔧 Auto Start Bot: ${process.env.AUTO_START_BOT === 'true' ? 'enabled' : 'disabled'}`);
  
  return { valid, warnings };
}