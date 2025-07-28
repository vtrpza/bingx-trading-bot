/**
 * Render deployment migration script
 * Forces PostgreSQL database schema updates for Render.com deployment
 * This ensures the database is always up-to-date with the latest model changes
 */

import { sequelize } from '../config/database';
import { logger } from '../utils/logger';
import Asset from '../models/Asset';

async function runRenderDeployMigration() {
  
  try {
    logger.info('🚀 RENDER DEPLOY: Starting forced database migration...');
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`Database URL configured: ${!!process.env.DATABASE_URL}`);
    
    // Test database connection first with retry logic
    let connectionAttempts = 0;
    const maxAttempts = 3;
    
    while (connectionAttempts < maxAttempts) {
      try {
        await sequelize.authenticate();
        logger.info('✅ Database connection established');
        break;
      } catch (connError) {
        connectionAttempts++;
        logger.warn(`⚠️  Database connection attempt ${connectionAttempts}/${maxAttempts} failed:`, connError);
        
        if (connectionAttempts >= maxAttempts) {
          throw new Error(`Failed to connect to database after ${maxAttempts} attempts: ${connError}`);
        }
        
        // Wait 2 seconds before retry
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    const dialect = sequelize.getDialect();
    logger.info(`📊 Database dialect: ${dialect}`);
    
    if (dialect !== 'postgres') {
      logger.warn('⚠️  Not PostgreSQL - skipping Render-specific migration');
      return { success: true, skipped: true, dialect };
    }
    
    // Additional PostgreSQL connection validation
    try {
      await sequelize.query('SELECT version()');
      logger.info('✅ PostgreSQL version check passed');
    } catch (versionError) {
      logger.warn('⚠️  PostgreSQL version check failed (non-critical):', versionError);
    }
    
    // FORCE SCHEMA SYNC - This will update the database to match current models
    logger.info('🔥 FORCE SYNC: Updating PostgreSQL schema to match current models...');
    
    // Import all models to ensure they're registered
    try {
      await import('../models/Asset');
      logger.info('✅ Models imported successfully');
    } catch (modelError) {
      logger.error('❌ Failed to import models:', modelError);
      throw new Error(`Model import failed: ${modelError}`);
    }
    
    // Sync with alter: true to update existing tables
    try {
      logger.info('🔄 Starting database sync (alter: true)...');
      await sequelize.sync({ 
        alter: true,  // Modify existing tables to match models
        force: false  // Don't drop tables
      });
      logger.info('✅ Database schema forcefully synchronized');
      
      // Verify sync worked by checking if models are properly loaded
      const modelNames = Object.keys(sequelize.models);
      logger.info(`📋 Models registered: ${modelNames.join(', ')}`);
      
      if (!modelNames.includes('Asset')) {
        logger.warn('⚠️  Asset model not found in registered models');
        // Try to ensure Asset model is loaded
        await import('../models/Asset');
        const updatedModels = Object.keys(sequelize.models);
        logger.info(`📋 Models after re-import: ${updatedModels.join(', ')}`);
      }
      
    } catch (syncError) {
      logger.error('❌ Database sync failed:', syncError);
      throw new Error(`Database sync failed: ${syncError}`);
    }
    
    // Verify Asset table exists and has correct structure (NON-CRITICAL for deployment)
    try {
      // The Asset model uses lowercase 'assets' as tableName
      const queryInterface = sequelize.getQueryInterface();
      
      // First, list all available tables for debugging
      let allTables: string[] = [];
      try {
        allTables = await queryInterface.showAllTables();
        logger.info('📋 Available tables in database:', allTables);
      } catch (showError) {
        logger.warn('⚠️  Could not list tables:', showError);
      }
      
      // Try to find the assets table with different case variations
      const possibleNames = ['assets', 'Assets', 'ASSETS'];
      let tableFound = false;
      let actualTableName = '';
      
      for (const tableName of possibleNames) {
        try {
          logger.info(`🔍 Checking for table: ${tableName}`);
          const assetTableInfo = await queryInterface.describeTable(tableName);
          
          const columnCount = Object.keys(assetTableInfo).length;
          logger.info(`📋 ✅ Found table ${tableName} with ${columnCount} columns`);
          
          // Log some column names for verification
          const columns = Object.keys(assetTableInfo).slice(0, 5);
          logger.debug(`Sample columns: ${columns.join(', ')}`);
          
          tableFound = true;
          actualTableName = tableName;
          break;
        } catch (err) {
          logger.debug(`❌ Table ${tableName} not found or not accessible`);
        }
      }
      
      if (!tableFound) {
        logger.warn('⚠️  Assets table not found with any case variation');
        logger.warn('💡 This may be normal if this is the first deployment');
        logger.warn('📋 Available tables:', allTables.length > 0 ? allTables.join(', ') : 'None found');
      } else {
        logger.info(`✅ Successfully verified table: ${actualTableName}`);
      }
      
    } catch (tableError: any) {
      logger.warn('⚠️  Table verification failed (non-critical for deployment):', tableError);
      logger.warn('💡 Migration will continue - table may be created during first app run');
    }
    
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
      await sequelize.query('ANALYZE "assets";');
      logger.info('✅ Updated PostgreSQL table statistics');
    } catch (error) {
      logger.warn('⚠️  Failed to update statistics (non-critical):', error);
    }
    
    // Test basic Asset operations (NON-CRITICAL for deployment)
    try {
      const assetCount = await Asset.count();
      logger.info(`📊 ✅ Asset model operational: ${assetCount} records`);
    } catch (error) {
      logger.warn('⚠️  Asset model test failed (non-critical for deployment):', error);
      logger.warn('💡 This may be normal for first deployment - table will be created when app starts');
    }
    
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
    logger.error('🔍 Error details:', {
      message: error?.message,
      name: error?.name,
      stack: error?.stack?.split('\n').slice(0, 5).join('\n'), // First 5 lines of stack
      code: error?.code,
      errno: error?.errno,
      syscall: error?.syscall
    });
    
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
    // Core performance indexes for assets table (lowercase, matching model tableName)
    'idx_assets_symbol_unique': `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_symbol_unique 
      ON "assets" (symbol);
    `,
    'idx_assets_status_performance': `
      CREATE INDEX IF NOT EXISTS idx_assets_status_performance 
      ON "assets" (status, "quoteVolume24h", "priceChangePercent")
      WHERE status IN ('TRADING', 'SUSPENDED', 'DELISTED');
    `,
    'idx_assets_volume_trading': `
      CREATE INDEX IF NOT EXISTS idx_assets_volume_trading 
      ON "assets" ("quoteVolume24h") 
      WHERE status = 'TRADING' AND "quoteVolume24h" > 0;
    `,
    'idx_assets_search_composite': `
      CREATE INDEX IF NOT EXISTS idx_assets_search_composite 
      ON "assets" (symbol, name, status);
    `,
    'idx_assets_updated_recent': `
      CREATE INDEX IF NOT EXISTS idx_assets_updated_recent 
      ON "assets" ("updatedAt");
    `
  };
}

// CLI execution
if (require.main === module) {
  runRenderDeployMigration()
    .then(result => {
      logger.info('🎉 Render deploy migration completed:', result);
      
      // In production, don't fail deployment even if migration has issues
      // This allows the server to start and potentially recover
      if (process.env.NODE_ENV === 'production') {
        if (!result.success) {
          logger.warn('⚠️  Migration had issues but allowing deployment to continue...');
        }
        process.exit(0); // Always succeed in production
      } else {
        process.exit(result.success ? 0 : 1);
      }
    })
    .catch(error => {
      logger.error('🚨 CRITICAL: Render deploy migration crashed:', error);
      
      // In production, log the crash but don't fail the deployment
      if (process.env.NODE_ENV === 'production') {
        logger.error('💡 PRODUCTION: Allowing deployment to continue despite migration crash');
        logger.error('🔧 Manual database intervention may be required after deployment');
        process.exit(0); // Don't fail production deployments
      } else {
        process.exit(1);
      }
    });
}

export { runRenderDeployMigration };