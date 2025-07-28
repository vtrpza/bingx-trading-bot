/**
 * Initialize database and create optimized indexes
 */

import { sequelize } from '../config/database';
import { logger } from '../utils/logger';
import Asset from '../models/Asset';

async function initializeAndCreateIndexes() {
  try {
    logger.info('🚀 Initializing database and creating indexes...');
    
    // Force sync to create tables
    await sequelize.sync({ force: false, alter: true });
    logger.info('✅ Database synchronized');
    
    // Now create indexes using raw SQL for better control
    const dialect = sequelize.getDialect();
    logger.info(`📊 Database dialect: ${dialect}`);
    
    const indexes = [
      // Volume-based sorting (most common query)
      `CREATE INDEX IF NOT EXISTS idx_assets_volume_24h_desc ON Assets (quoteVolume24h DESC)`,
      
      // Status + volume composite index
      `CREATE INDEX IF NOT EXISTS idx_assets_status_volume ON Assets (status, quoteVolume24h DESC)`,
      
      // Price change for gainers/losers
      `CREATE INDEX IF NOT EXISTS idx_assets_price_change_desc ON Assets (priceChangePercent DESC)`,
      
      // Symbol search
      `CREATE INDEX IF NOT EXISTS idx_assets_symbol_search ON Assets (symbol)`,
      
      // Name search
      `CREATE INDEX IF NOT EXISTS idx_assets_name_search ON Assets (name)`,
      
      // Updated timestamp
      `CREATE INDEX IF NOT EXISTS idx_assets_updated_at ON Assets (updatedAt DESC)`,
      
      // Composite index for common filters
      `CREATE INDEX IF NOT EXISTS idx_assets_composite_filter ON Assets (status, updatedAt DESC, quoteVolume24h DESC)`,
      
      // Trading-specific comprehensive index
      `CREATE INDEX IF NOT EXISTS idx_assets_trading_comprehensive ON Assets (quoteVolume24h DESC, priceChangePercent DESC, updatedAt DESC)`,
      
      // Leverage and margin rates
      `CREATE INDEX IF NOT EXISTS idx_assets_leverage_risk ON Assets (maxLeverage, maintMarginRate)`,
      
      // Price range queries
      `CREATE INDEX IF NOT EXISTS idx_assets_price_range ON Assets (lastPrice, highPrice24h, lowPrice24h)`
    ];
    
    let successCount = 0;
    
    for (const [index, sql] of indexes.entries()) {
      try {
        await sequelize.query(sql);
        logger.info(`✅ Created index ${index + 1}/${indexes.length}`);
        successCount++;
      } catch (error: any) {
        if (error.message.includes('already exists')) {
          logger.debug(`⏭️  Index ${index + 1} already exists, skipping`);
          successCount++;
        } else {
          logger.warn(`⚠️  Failed to create index ${index + 1}: ${error.message}`);
        }
      }
    }
    
    // Update table statistics
    try {
      await sequelize.query('ANALYZE Assets');
      logger.info('✅ Updated table statistics');
    } catch (error) {
      logger.warn('⚠️  Failed to update statistics:', error);
    }
    
    // Verify indexes
    await verifyIndexes(dialect);
    
    logger.info(`🎉 Database initialization and indexing completed!`);
    logger.info(`📊 Results: ${successCount}/${indexes.length} indexes created/verified`);
    
    return { success: true, dialect, successCount, totalIndexes: indexes.length };
    
  } catch (error) {
    logger.error('❌ Database initialization failed:', error);
    throw error;
  }
}

async function verifyIndexes(dialect: string) {
  try {
    logger.info('🔍 Verifying database indexes...');
    
    let indexQuery: string;
    if (dialect === 'postgres') {
      indexQuery = `
        SELECT indexname FROM pg_indexes 
        WHERE tablename = 'Assets' 
        AND indexname LIKE 'idx_assets_%'
        ORDER BY indexname;
      `;
    } else {
      indexQuery = `
        SELECT name as indexname FROM sqlite_master 
        WHERE type = 'index' 
        AND tbl_name = 'Assets' 
        AND name LIKE 'idx_assets_%'
        ORDER BY name;
      `;
    }
    
    const [indexes] = await sequelize.query(indexQuery);
    const indexList = indexes as any[];
    
    logger.info(`📋 Found ${indexList.length} optimized indexes:`);
    indexList.forEach((index: any) => {
      logger.info(`  ✓ ${index.indexname}`);
    });
    
    if (indexList.length === 0) {
      logger.warn('⚠️  No indexes found - this may affect query performance');
    } else {
      logger.info('✅ Database indexes verified successfully!');
    }
    
  } catch (error: any) {
    logger.warn('Index verification failed:', error.message);
  }
}

// Run the initialization
initializeAndCreateIndexes()
  .then(result => {
    logger.info('🎉 Database setup completed successfully:', result);
    process.exit(0);
  })
  .catch(error => {
    logger.error('Database setup failed:', error);
    process.exit(1);
  });