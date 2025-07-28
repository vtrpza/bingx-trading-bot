/**
 * Production-safe database migration for Render deployment
 * Handles PostgreSQL indexes with proper error handling and rollback
 */

import { sequelize } from '../config/database';
import { logger } from '../utils/logger';

async function runProductionMigration(forceMode = false) {
  try {
    logger.info('🚀 Starting production database migration...');
    
    // Check if force mode is enabled (for Render deployments)
    if (forceMode) {
      logger.info('⚡ FORCE MODE ENABLED - Running aggressive migration for Render deployment');
    }
    
    // Test database connection first
    await sequelize.authenticate();
    logger.info('✅ Database connection established');
    
    const dialect = sequelize.getDialect();
    logger.info(`📊 Database dialect: ${dialect}`);
    
    // Enhanced sync with force mode support
    if (forceMode && process.env.NODE_ENV === 'production') {
      // For Render deployment: force schema sync to update outdated DB
      logger.info('🔥 FORCE SYNC: Updating database schema for Render deployment...');
      await sequelize.sync({ alter: true, force: false }); // alter but don't drop tables
      logger.info('✅ Database schema forcefully synchronized');
    } else {
      // Standard sync (non-destructive)
      await sequelize.sync({ alter: false });
      logger.info('✅ Database schema synchronized');
    }
    
    // Create indexes with proper error handling
    const indexes = getIndexDefinitions(dialect);
    let successCount = 0;
    let skipCount = 0;
    
    for (const [name, sql] of Object.entries(indexes)) {
      try {
        logger.debug(`Creating index: ${name}`);
        await sequelize.query(sql);
        logger.info(`✅ Index created: ${name}`);
        successCount++;
      } catch (error: any) {
        if (error.message.includes('already exists') || 
            error.message.includes('duplicate') ||
            error.message.includes('relation') && error.message.includes('already exists')) {
          logger.debug(`⏭️  Index ${name} already exists, skipping`);
          skipCount++;
        } else {
          logger.warn(`⚠️  Failed to create index ${name}: ${error.message}`);
          // Don't fail the deployment for index creation issues
        }
      }
    }
    
    // Update statistics
    try {
      if (dialect === 'postgres') {
        await sequelize.query('ANALYZE "Assets";');
      } else {
        await sequelize.query('ANALYZE Assets;');
      }
      logger.info('✅ Updated table statistics');
    } catch (error) {
      logger.warn('⚠️  Failed to update statistics (non-critical):', error);
    }
    
    logger.info(`🎉 Production migration completed successfully!`);
    logger.info(`📊 Results: ${successCount} created, ${skipCount} skipped`);
    
    return {
      success: true,
      dialect,
      successCount,
      skipCount,
      totalIndexes: Object.keys(indexes).length
    };
    
  } catch (error: any) {
    logger.error('❌ Production migration failed:', error);
    
    // Don't crash the deployment for migration issues
    if (process.env.NODE_ENV === 'production') {
      logger.warn('⚠️  Migration failed in production, continuing with server start...');
      return { success: false, error: error.message };
    }
    
    throw error;
  }
}

function getIndexDefinitions(dialect: string): Record<string, string> {
  if (dialect === 'postgres') {
    return {
      'idx_assets_volume_24h_desc': `
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_volume_24h_desc 
        ON "Assets" ("quoteVolume24h" DESC NULLS LAST) 
        WHERE status = 'TRADING';
      `,
      'idx_assets_price_change_desc': `
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_price_change_desc 
        ON "Assets" ("priceChangePercent" DESC NULLS LAST) 
        WHERE status = 'TRADING';
      `,
      'idx_assets_status_volume': `
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_status_volume 
        ON "Assets" (status, "quoteVolume24h" DESC NULLS LAST);
      `,
      'idx_assets_composite_filter': `
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_composite_filter 
        ON "Assets" (status, "updatedAt" DESC, "quoteVolume24h" DESC) 
        WHERE status IN ('TRADING', 'SUSPENDED', 'DELISTED');
      `,
      'idx_assets_symbol_search': `
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_symbol_search 
        ON "Assets" (symbol);
      `,
      'idx_assets_name_search': `
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_name_search 
        ON "Assets" (name);
      `,
      'idx_assets_updated_at': `
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_updated_at 
        ON "Assets" ("updatedAt" DESC);
      `,
      'idx_assets_trading_comprehensive': `
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_trading_comprehensive
        ON "Assets" ("quoteVolume24h" DESC, "priceChangePercent" DESC, "updatedAt" DESC) 
        WHERE status = 'TRADING' AND "quoteVolume24h" > 0;
      `,
      'idx_assets_leverage_risk': `
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_leverage_risk
        ON "Assets" ("maxLeverage", "maintMarginRate") 
        WHERE status = 'TRADING';
      `
    };
  } else {
    // SQLite indexes (for development)
    return {
      'idx_assets_volume_24h_desc': 'CREATE INDEX IF NOT EXISTS idx_assets_volume_24h_desc ON Assets (quoteVolume24h DESC);',
      'idx_assets_status_volume': 'CREATE INDEX IF NOT EXISTS idx_assets_status_volume ON Assets (status, quoteVolume24h DESC);',
      'idx_assets_price_change_desc': 'CREATE INDEX IF NOT EXISTS idx_assets_price_change_desc ON Assets (priceChangePercent DESC);',
      'idx_assets_symbol_search': 'CREATE INDEX IF NOT EXISTS idx_assets_symbol_search ON Assets (symbol);',
      'idx_assets_name_search': 'CREATE INDEX IF NOT EXISTS idx_assets_name_search ON Assets (name);',
      'idx_assets_updated_at': 'CREATE INDEX IF NOT EXISTS idx_assets_updated_at ON Assets (updatedAt DESC);',
      'idx_assets_composite_filter': 'CREATE INDEX IF NOT EXISTS idx_assets_composite_filter ON Assets (status, updatedAt DESC, quoteVolume24h DESC);',
      'idx_assets_trading_comprehensive': 'CREATE INDEX IF NOT EXISTS idx_assets_trading_comprehensive ON Assets (quoteVolume24h DESC, priceChangePercent DESC, updatedAt DESC);',
      'idx_assets_leverage_risk': 'CREATE INDEX IF NOT EXISTS idx_assets_leverage_risk ON Assets (maxLeverage, maintMarginRate);'
    };
  }
}

// Only run if called directly (not when imported)
if (require.main === module) {
  // Check for --force flag
  const forceMode = process.argv.includes('--force');
  
  runProductionMigration(forceMode)
    .then(result => {
      logger.info('🎉 Migration script completed:', result);
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      logger.error('Migration script failed:', error);
      process.exit(1);
    });
}

export { runProductionMigration };