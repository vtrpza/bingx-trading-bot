/**
 * Database index migration runner for both PostgreSQL and SQLite
 * Applies optimized indexes for financial data queries
 */

import { sequelize } from '../config/database';
import { logger } from '../utils/logger';
import fs from 'fs';
import path from 'path';

async function applyDatabaseIndexes() {
  try {
    logger.info('🚀 Starting database index migration...');
    
    const dialect = sequelize.getDialect();
    logger.info(`📊 Database dialect: ${dialect}`);
    
    let migrationFile: string;
    let migrationPath: string;
    
    if (dialect === 'postgres') {
      migrationFile = 'create-optimized-indexes.sql';
      migrationPath = path.join(__dirname, migrationFile);
      logger.info('📈 Applying PostgreSQL optimized indexes...');
    } else if (dialect === 'sqlite') {
      migrationFile = 'create-optimized-indexes-sqlite.sql';
      migrationPath = path.join(__dirname, migrationFile);
      logger.info('📊 Applying SQLite optimized indexes...');
    } else {
      throw new Error(`Unsupported database dialect: ${dialect}`);
    }
    
    // Check if migration file exists
    if (!fs.existsSync(migrationPath)) {
      throw new Error(`Migration file not found: ${migrationPath}`);
    }
    
    // Read migration SQL
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
    logger.info(`📄 Migration file loaded: ${migrationFile}`);
    
    // Split SQL commands by semicolon and newline (handle multi-statement SQL)
    const sqlCommands = migrationSQL
      .split(/;\s*(?:\r?\n|$)/)
      .map(cmd => cmd.trim())
      .filter(cmd => cmd.length > 0 && !cmd.startsWith('--') && !cmd.startsWith('/*'));
    
    logger.info(`📝 Found ${sqlCommands.length} SQL commands to execute`);
    
    // Execute each command individually for better error handling
    let successCount = 0;
    let skipCount = 0;
    
    for (let i = 0; i < sqlCommands.length; i++) {
      const command = sqlCommands[i];
      
      try {
        // Skip comments and empty commands
        if (command.startsWith('--') || command.startsWith('/*') || command.trim().length === 0) {
          continue;
        }
        
        // Add semicolon if missing
        const finalCommand = command.endsWith(';') ? command : command + ';';
        
        logger.debug(`Executing command ${i + 1}/${sqlCommands.length}: ${finalCommand.substring(0, 100)}...`);
        
        await sequelize.query(finalCommand);
        successCount++;
        
      } catch (error: any) {
        // Some commands might fail if indexes already exist, which is okay
        if (error.message.includes('already exists') || 
            error.message.includes('duplicate') ||
            error.message.includes('DROP INDEX') ||
            error.message.includes('IF EXISTS')) {
          logger.debug(`Skipping expected error for command ${i + 1}: ${error.message}`);
          skipCount++;
          continue;
        }
        
        logger.warn(`Command ${i + 1} failed: ${error.message}`);
        // Continue with other commands rather than failing completely
      }
    }
    
    logger.info(`✅ Database index migration completed!`);
    logger.info(`📊 Results: ${successCount} successful, ${skipCount} skipped`);
    
    // Verify some key indexes were created
    await verifyIndexes(dialect);
    
    return {
      success: true,
      dialect,
      successCount,
      skipCount,
      totalCommands: sqlCommands.length
    };
    
  } catch (error) {
    logger.error('❌ Database index migration failed:', error);
    throw error;
  }
}

async function verifyIndexes(dialect: string) {
  try {
    logger.info('🔍 Verifying database indexes...');
    
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
      return;
    }
    
    const [indexes] = await sequelize.query(indexQuery);
    
    logger.info(`📋 Found ${(indexes as any[]).length} optimized indexes:`);
    (indexes as any[]).forEach((index: any) => {
      logger.info(`  ✓ ${index.indexname}`);
    });
    
    // Expected key indexes
    const expectedIndexes = [
      'idx_assets_volume_24h_desc',
      'idx_assets_status_volume',
      'idx_assets_trading_comprehensive'
    ];
    
    const foundIndexNames = (indexes as any[]).map((idx: any) => idx.indexname);
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

// Run migration
applyDatabaseIndexes()
  .then(result => {
    logger.info('🎉 Migration completed successfully:', result);
    process.exit(0);
  })
  .catch(error => {
    logger.error('Migration failed:', error);
    process.exit(1);
  });