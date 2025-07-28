/**
 * Create database indexes using Sequelize for both PostgreSQL and SQLite
 * This approach works better with Sequelize's ORM layer
 */

import { sequelize } from '../config/database';
import { logger } from '../utils/logger';

async function createOptimizedIndexes() {
  try {
    logger.info('🚀 Creating optimized database indexes using Sequelize...');
    
    const queryInterface = sequelize.getQueryInterface();
    const dialect = sequelize.getDialect();
    
    logger.info(`📊 Database dialect: ${dialect}`);
    
    // Check if Assets table exists
    const tables = await queryInterface.showAllTables();
    const assetsTableExists = tables.includes('Assets');
    
    if (!assetsTableExists) {
      logger.warn('⚠️  Assets table not found. Please ensure the table exists before creating indexes.');
      return;
    }
    
    logger.info('✅ Assets table found, proceeding with index creation...');
    
    // Define indexes to create
    const indexes = [
      {
        name: 'idx_assets_volume_24h_desc',
        fields: [{ name: 'quoteVolume24h', order: 'DESC' as 'DESC' as 'DESC' }],
        where: dialect === 'postgres' ? { status: 'TRADING' } : undefined
      },
      {
        name: 'idx_assets_price_change_desc',
        fields: [{ name: 'priceChangePercent', order: 'DESC' as 'DESC' }],
        where: dialect === 'postgres' ? { status: 'TRADING' } : undefined
      },
      {
        name: 'idx_assets_status_volume',
        fields: ['status', { name: 'quoteVolume24h', order: 'DESC' as 'DESC' }]
      },
      {
        name: 'idx_assets_composite_filter',
        fields: ['status', { name: 'updatedAt', order: 'DESC' as 'DESC' }, { name: 'quoteVolume24h', order: 'DESC' as 'DESC' }]
      },
      {
        name: 'idx_assets_symbol_search',
        fields: ['symbol']
      },
      {
        name: 'idx_assets_name_search',
        fields: ['name']
      },
      {
        name: 'idx_assets_updated_at',
        fields: [{ name: 'updatedAt', order: 'DESC' as 'DESC' }]
      },
      {
        name: 'idx_assets_trading_comprehensive',
        fields: [
          { name: 'quoteVolume24h', order: 'DESC' as 'DESC' },
          { name: 'priceChangePercent', order: 'DESC' as 'DESC' },
          { name: 'updatedAt', order: 'DESC' as 'DESC' }
        ],
        where: dialect === 'postgres' ? { status: 'TRADING', quoteVolume24h: { [require('sequelize').Op.gt]: 0 } } : undefined
      },
      {
        name: 'idx_assets_leverage_risk',
        fields: ['maxLeverage', 'maintMarginRate'],
        where: dialect === 'postgres' ? { status: 'TRADING' } : undefined
      },
      {
        name: 'idx_assets_price_range',
        fields: ['lastPrice', 'highPrice24h', 'lowPrice24h'],
        where: dialect === 'postgres' ? { status: 'TRADING', lastPrice: { [require('sequelize').Op.gt]: 0 } } : undefined
      }
    ];
    
    let successCount = 0;
    let skipCount = 0;
    
    // Create indexes one by one
    for (const indexConfig of indexes) {
      try {
        logger.debug(`Creating index: ${indexConfig.name}`);
        
        // Remove 'where' clause for SQLite as it has limited support
        const config = dialect === 'sqlite' 
          ? { ...indexConfig, where: undefined }
          : indexConfig;
        
        await queryInterface.addIndex('Assets', {
          name: config.name,
          fields: config.fields,
          where: config.where,
          concurrently: dialect === 'postgres'
        });
        
        logger.info(`✅ Created index: ${indexConfig.name}`);
        successCount++;
        
      } catch (error: any) {
        if (error.message.includes('already exists') || 
            error.message.includes('duplicate')) {
          logger.debug(`⏭️  Index ${indexConfig.name} already exists, skipping`);
          skipCount++;
        } else {
          logger.warn(`⚠️  Failed to create index ${indexConfig.name}: ${error.message}`);
        }
      }
    }
    
    // Run ANALYZE to update statistics
    try {
      if (dialect === 'postgres') {
        await sequelize.query('ANALYZE "Assets";');
        logger.info('✅ Updated PostgreSQL table statistics');
      } else if (dialect === 'sqlite') {
        await sequelize.query('ANALYZE Assets;');
        logger.info('✅ Updated SQLite table statistics');
      }
    } catch (error) {
      logger.warn('⚠️  Failed to update table statistics:', error);
    }
    
    logger.info(`🎉 Index creation completed!`);
    logger.info(`📊 Results: ${successCount} created, ${skipCount} already existed`);
    
    // Verify indexes
    await verifyCreatedIndexes();
    
    return {
      success: true,
      dialect,
      successCount,
      skipCount,
      totalIndexes: indexes.length
    };
    
  } catch (error) {
    logger.error('❌ Index creation failed:', error);
    throw error;
  }
}

async function verifyCreatedIndexes() {
  try {
    logger.info('🔍 Verifying created indexes...');
    
    const dialect = sequelize.getDialect();
    let indexQuery: string;
    
    if (dialect === 'postgres') {
      indexQuery = `
        SELECT indexname, tablename 
        FROM pg_indexes 
        WHERE tablename = 'Assets' 
        AND indexname LIKE 'idx_assets_%'
        ORDER BY indexname;
      `;
    } else if (dialect === 'sqlite') {
      indexQuery = `
        SELECT name as indexname, tbl_name as tablename 
        FROM sqlite_master 
        WHERE type = 'index' 
        AND tbl_name = 'Assets' 
        AND name LIKE 'idx_assets_%'
        ORDER BY name;
      `;
    } else {
      logger.warn('Index verification not supported for this database type');
      return;
    }
    
    const [indexes] = await sequelize.query(indexQuery);
    const indexList = indexes as any[];
    
    logger.info(`📋 Found ${indexList.length} optimized indexes:`);
    indexList.forEach((index: any) => {
      logger.info(`  ✓ ${index.indexname}`);
    });
    
    // Check for key indexes
    const expectedIndexes = [
      'idx_assets_volume_24h_desc',
      'idx_assets_status_volume',
      'idx_assets_symbol_search'
    ];
    
    const foundIndexNames = indexList.map((idx: any) => idx.indexname);
    const missingIndexes = expectedIndexes.filter(expected => 
      !foundIndexNames.includes(expected)
    );
    
    if (missingIndexes.length > 0) {
      logger.warn(`⚠️  Missing expected indexes: ${missingIndexes.join(', ')}`);
    } else {
      logger.info('✅ All key indexes verified successfully!');
    }
    
  } catch (error: any) {
    logger.warn('Index verification failed:', error.message);
  }
}

// Run the migration
createOptimizedIndexes()
  .then(result => {
    logger.info('🎉 Database index creation completed successfully:', result);
    process.exit(0);
  })
  .catch(error => {
    logger.error('Database index creation failed:', error);
    process.exit(1);
  });