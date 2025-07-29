/**
 * Environment validation for production deployment
 */
import { logger } from './logger';

export function validateEnvironment(): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  let valid = true;

  const isDevelopment = process.env.NODE_ENV === 'development';

  // Critical environment variables
  const critical = [
    'NODE_ENV'
  ];

  // Critical for production only
  const productionCritical = [
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

  // Check production-critical variables
  for (const envVar of productionCritical) {
    if (!process.env[envVar]) {
      if (isDevelopment) {
        logger.warn(`⚠️  Production variable ${envVar} not set (using defaults for development)`);
      } else {
        logger.error(`❌ Missing critical production variable: ${envVar}`);
        valid = false;
      }
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
  
  if (!valid) {
    logger.error('❌ Environment validation failed - critical variables missing');
  } else if (warnings.length > 0) {
    logger.warn('⚠️  Environment validation passed with warnings - some optional features may not work');
  } else {
    logger.info('✅ Environment validation passed - all systems ready');
  }
  
  return { valid, warnings };
}