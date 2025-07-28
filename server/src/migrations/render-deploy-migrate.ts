/**
 * Render deployment migration script
 * Forces PostgreSQL database schema updates for Render.com deployment
 * This ensures the database is always up-to-date with the latest model changes
 */

import { sequelize } from '../config/database';
import { logger } from '../utils/logger';
import Asset from '../models/Asset';

async function runRenderDeployMigration() {
  // let migrationSuccess = false;
  
  try {
    logger.info('🚀 RENDER DEPLOY: Starting forced database migration...');
    
    // Test database connection first
    await sequelize.authenticate();
    logger.info('✅ Database connection established');
    
    const dialect = sequelize.getDialect();
    logger.info(`📊 Database dialect: ${dialect}`);
    
    if (dialect !== 'postgres') {
      logger.warn('⚠️  Not PostgreSQL - skipping Render-specific migration');
      return { success: true, skipped: true };
    }
    
    // FORCE SCHEMA SYNC - This will update the database to match current models
    logger.info('🔥 FORCE SYNC: Updating PostgreSQL schema to match current models...');
    
    // Import all models to ensure they're registered
    await import('../models/Asset');
    
    // Sync with alter: true to update existing tables
    await sequelize.sync({ 
      alter: true,  // Modify existing tables to match models
      force: false  // Don't drop tables
    });
    
    logger.info('✅ Database schema forcefully synchronized');
    
    // Verify Asset table exists and has correct structure
    const assetTableInfo = await sequelize.getQueryInterface().describeTable('Assets');
    logger.info(`📋 Assets table structure verified: ${Object.keys(assetTableInfo).length} columns`);
    
    // Create/update indexes with enhanced error handling
    const indexes = getRenderOptimizedIndexes();
    let successCount = 0;
    let skipCount = 0;
    
    for (const [name, sql] of Object.entries(indexes)) {
      try {
        logger.debug(`Creating/updating index: ${name}`);
        await sequelize.query(sql);
        logger.info(`✅ Index processed: ${name}`);
        successCount++;
      } catch (error: any) {
        if (error.message.includes('already exists') || 
            error.message.includes('duplicate') ||
            (error.message.includes('relation') && error.message.includes('already exists'))) {
          logger.debug(`⏭️  Index ${name} already exists, skipping`);
          skipCount++;
        } else {
          logger.warn(`⚠️  Failed to process index ${name}: ${error.message}`);
          // Don't fail deployment for index issues
        }
      }
    }
    
    // Update table statistics for better query performance
    try {
      await sequelize.query('ANALYZE "Assets";');
      logger.info('✅ Updated PostgreSQL table statistics');
    } catch (error) {
      logger.warn('⚠️  Failed to update statistics (non-critical):', error);
    }
    
    // Test basic Asset operations
    try {
      const assetCount = await Asset.count();
      logger.info(`📊 Asset table operational: ${assetCount} records`);
    } catch (error) {
      logger.error('❌ Asset table test failed:', error);
      throw new Error('Asset table is not operational after migration');
    }
    
    // migrationSuccess = true;
    
    logger.info('🎉 RENDER DEPLOY MIGRATION COMPLETED SUCCESSFULLY!');
    logger.info(`📊 Results: ${successCount} indexes processed, ${skipCount} skipped`);
    
    return {
      success: true,
      dialect,
      successCount,
      skipCount,
      totalIndexes: Object.keys(indexes).length,
      forced: true
    };
    
  } catch (error: any) {
    logger.error('❌ Render deployment migration failed:', error);
    
    // In production, log the error but don't crash the deployment
    if (process.env.NODE_ENV === 'production') {
      logger.error('🚨 CRITICAL: Migration failed in production deployment!');
      logger.error('💡 Manual database intervention may be required');
      logger.warn('⚠️  Continuing with server start despite migration failure...');
      
      return { 
        success: false, 
        error: error.message,
        requiresManualIntervention: true 
      };
    }
    
    throw error;
  }
}

function getRenderOptimizedIndexes(): Record<string, string> {
  return {
    // Core performance indexes for Assets table
    'idx_assets_symbol_unique': `
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_symbol_unique 
      ON "Assets" (symbol);
    `,
    'idx_assets_status_performance': `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_status_performance 
      ON "Assets" (status, "quoteVolume24h" DESC NULLS LAST, "priceChangePercent" DESC NULLS LAST)
      WHERE status IN ('TRADING', 'SUSPENDED', 'DELISTED');
    `,
    'idx_assets_volume_trading': `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_volume_trading 
      ON "Assets" ("quoteVolume24h" DESC NULLS LAST) 
      WHERE status = 'TRADING' AND "quoteVolume24h" > 0;
    `,
    'idx_assets_price_change_trading': `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_price_change_trading 
      ON "Assets" ("priceChangePercent" DESC NULLS LAST) 
      WHERE status = 'TRADING';
    `,
    'idx_assets_search_composite': `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_search_composite 
      ON "Assets" (symbol, name, status);
    `,
    'idx_assets_updated_recent': `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_updated_recent 
      ON "Assets" ("updatedAt" DESC)
      WHERE "updatedAt" > NOW() - INTERVAL '7 days';
    `,
    'idx_assets_leverage_analysis': `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_leverage_analysis
      ON "Assets" ("maxLeverage", "maintMarginRate", "minQty") 
      WHERE status = 'TRADING' AND "maxLeverage" > 1;
    `,
    'idx_assets_market_data_complete': `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_market_data_complete
      ON "Assets" ("lastPrice", "volume24h", "highPrice24h", "lowPrice24h") 
      WHERE status = 'TRADING' AND "lastPrice" > 0;
    `
  };
}

// CLI execution
if (require.main === module) {
  runRenderDeployMigration()
    .then(result => {
      logger.info('🎉 Render deploy migration completed:', result);
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      logger.error('Render deploy migration failed:', error);
      process.exit(1);
    });
}

export { runRenderDeployMigration };