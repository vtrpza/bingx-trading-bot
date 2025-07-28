/**
 * Deployment verification script for Render
 * Verifies that the database migration was successful and all models are working
 */

import { sequelize } from '../config/database';
import { logger } from '../utils/logger';
import { QueryTypes } from 'sequelize';
import Asset from '../models/Asset';

async function verifyDeployment() {
  try {
    logger.info('🔍 DEPLOYMENT VERIFICATION: Starting post-migration checks...');
    
    // Test database connection
    await sequelize.authenticate();
    logger.info('✅ Database connection: OK');
    
    const dialect = sequelize.getDialect();
    logger.info(`📊 Database dialect: ${dialect}`);
    
    // Test Asset model
    try {
      const assetCount = await Asset.count();
      logger.info(`✅ Asset model: OK (${assetCount} records)`);
    } catch (error) {
      logger.error('❌ Asset model test failed:', error);
      throw new Error('Asset model is not operational');
    }
    
    // Test Asset table structure
    try {
      const tableInfo = await sequelize.getQueryInterface().describeTable('Assets');
      const columnCount = Object.keys(tableInfo).length;
      logger.info(`✅ Assets table structure: OK (${columnCount} columns)`);
      
      // Verify critical columns exist
      const requiredColumns = ['symbol', 'status', 'lastPrice', 'quoteVolume24h', 'updatedAt'];
      const existingColumns = Object.keys(tableInfo);
      const missingColumns = requiredColumns.filter(col => !existingColumns.includes(col));
      
      if (missingColumns.length > 0) {
        throw new Error(`Missing required columns: ${missingColumns.join(', ')}`);
      }
      
      logger.info('✅ Required columns: All present');
      
    } catch (error) {
      logger.error('❌ Table structure verification failed:', error);
      throw error;
    }
    
    // Test index functionality (if available)
    if (dialect === 'postgres') {
      try {
        const indexQuery = `
          SELECT indexname, indexdef 
          FROM pg_indexes 
          WHERE tablename = 'Assets' 
          AND indexname LIKE 'idx_assets_%';
        `;
        
        const indexes = await sequelize.query(indexQuery, { 
          type: QueryTypes.SELECT 
        }) as any[];
        
        logger.info(`✅ Database indexes: ${indexes.length} custom indexes found`);
        
        if (indexes.length > 0) {
          logger.debug('Index details:', indexes.map(idx => idx.indexname));
        }
        
      } catch (error) {
        logger.warn('⚠️  Index verification failed (non-critical):', error);
      }
    }
    
    // Test basic CRUD operations
    try {
      // Try to create and delete a test record
      const testSymbol = `TEST_VERIFY_${Date.now()}`;
      
      await Asset.create({
        symbol: testSymbol,
        name: 'Test Asset',
        baseCurrency: 'TEST',
        quoteCurrency: 'USDT',
        status: 'TRADING',
        lastPrice: 1.0,
        priceChangePercent: 0,
        volume24h: 0,
        quoteVolume24h: 0,
        highPrice24h: 1.0,
        lowPrice24h: 1.0,
        openInterest: 0,
        minQty: 0.001,
        maxQty: 1000000,
        tickSize: 0.0001,
        stepSize: 0.001,
        maxLeverage: 100,
        maintMarginRate: 0.01
      });
      
      // Verify the test asset was created
      const foundAsset = await Asset.findOne({ where: { symbol: testSymbol } });
      if (!foundAsset) {
        throw new Error('Test asset creation failed');
      }
      
      // Clean up test asset
      await Asset.destroy({ where: { symbol: testSymbol } });
      
      logger.info('✅ CRUD operations: OK');
      
    } catch (error) {
      logger.error('❌ CRUD operations test failed:', error);
      throw error;
    }
    
    logger.info('🎉 DEPLOYMENT VERIFICATION COMPLETED SUCCESSFULLY!');
    logger.info('🚀 Database is ready for production use');
    
    return {
      success: true,
      dialect,
      timestamp: new Date().toISOString(),
      checks: {
        connection: true,
        assetModel: true,
        tableStructure: true,
        crudOperations: true
      }
    };
    
  } catch (error: any) {
    logger.error('❌ DEPLOYMENT VERIFICATION FAILED:', error);
    
    return {
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
      requiresAttention: true
    };
  }
}

// CLI execution
if (require.main === module) {
  verifyDeployment()
    .then(result => {
      console.log('\n=== DEPLOYMENT VERIFICATION RESULT ===');
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Verification script failed:', error);
      process.exit(1);
    });
}

export { verifyDeployment };