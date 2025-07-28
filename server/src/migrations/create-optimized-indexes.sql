-- High-performance database indexes for financial data optimization
-- Optimized for the AssetsPage data flow and trading bot operations

-- Enable concurrent index creation to avoid blocking operations
SET maintenance_work_mem = '1GB';

-- Drop existing indexes if they exist (for migration safety)
DROP INDEX IF EXISTS idx_assets_volume_24h_desc;
DROP INDEX IF EXISTS idx_assets_price_change_desc;
DROP INDEX IF EXISTS idx_assets_status_volume;
DROP INDEX IF EXISTS idx_assets_search_volume;
DROP INDEX IF EXISTS idx_assets_trading_only;
DROP INDEX IF EXISTS idx_assets_updated_at;
DROP INDEX IF EXISTS idx_assets_composite_filter;
DROP INDEX IF EXISTS idx_assets_symbol_text_search;

-- 1. Volume-based indexes for sorting and filtering (most common queries)
CREATE INDEX CONCURRENTLY idx_assets_volume_24h_desc 
ON "Assets" ("quoteVolume24h" DESC NULLS LAST) 
WHERE status = 'TRADING';

-- 2. Price change index for gainers/losers queries
CREATE INDEX CONCURRENTLY idx_assets_price_change_desc 
ON "Assets" ("priceChangePercent" DESC NULLS LAST) 
WHERE status = 'TRADING';

-- 3. Composite index for status + volume filtering (covers most frontend queries)
CREATE INDEX CONCURRENTLY idx_assets_status_volume 
ON "Assets" (status, "quoteVolume24h" DESC NULLS LAST);

-- 4. Multi-column index for pagination queries
CREATE INDEX CONCURRENTLY idx_assets_composite_filter 
ON "Assets" (status, "updatedAt" DESC, "quoteVolume24h" DESC) 
WHERE status IN ('TRADING', 'SUSPENDED', 'DELISTED');

-- 5. Text search index for symbol and name searches
-- Using GIN index with trigram extension for fast LIKE queries
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY idx_assets_symbol_text_search 
ON "Assets" USING gin((symbol || ' ' || name) gin_trgm_ops);

-- 6. Time-based index for recent updates
CREATE INDEX CONCURRENTLY idx_assets_updated_at 
ON "Assets" ("updatedAt" DESC);

-- 7. Partial index for active trading pairs only (most queried subset)
CREATE INDEX CONCURRENTLY idx_assets_trading_comprehensive
ON "Assets" ("quoteVolume24h" DESC, "priceChangePercent" DESC, "updatedAt" DESC) 
WHERE status = 'TRADING' AND "quoteVolume24h" > 0;

-- 8. Index for leverage-based queries (trading bot specific)
CREATE INDEX CONCURRENTLY idx_assets_leverage_risk
ON "Assets" ("maxLeverage", "maintMarginRate") 
WHERE status = 'TRADING';

-- 9. Specialized index for price range queries
CREATE INDEX CONCURRENTLY idx_assets_price_range
ON "Assets" ("lastPrice", "highPrice24h", "lowPrice24h") 
WHERE status = 'TRADING' AND "lastPrice" > 0;

-- 10. Index for open interest analysis
CREATE INDEX CONCURRENTLY idx_assets_open_interest
ON "Assets" ("openInterest" DESC NULLS LAST) 
WHERE status = 'TRADING' AND "openInterest" > 0;

-- Statistics for query planning optimization
ANALYZE "Assets";

-- Create custom statistics for better query planning
CREATE STATISTICS IF NOT EXISTS stats_assets_status_volume 
ON status, "quoteVolume24h" FROM "Assets";

CREATE STATISTICS IF NOT EXISTS stats_assets_price_change_volume 
ON "priceChangePercent", "quoteVolume24h" FROM "Assets";

-- Update table statistics
ANALYZE "Assets";

-- Performance monitoring views
CREATE OR REPLACE VIEW v_assets_index_usage AS
SELECT 
    schemaname,
    tablename,
    indexname,
    idx_tup_read,
    idx_tup_fetch,
    idx_scan,
    CASE 
        WHEN idx_scan = 0 THEN 'UNUSED'
        WHEN idx_scan < 100 THEN 'LOW_USAGE' 
        WHEN idx_scan < 1000 THEN 'MEDIUM_USAGE'
        ELSE 'HIGH_USAGE'
    END as usage_level
FROM pg_stat_user_indexes 
WHERE tablename = 'Assets'
ORDER BY idx_scan DESC;

CREATE OR REPLACE VIEW v_assets_query_performance AS
SELECT 
    'Assets' as table_name,
    seq_scan,
    seq_tup_read,
    idx_scan,
    idx_tup_fetch,
    CASE 
        WHEN seq_scan + idx_scan = 0 THEN 0
        ELSE ROUND((idx_scan::float / (seq_scan + idx_scan) * 100), 2)
    END as index_usage_ratio,
    n_tup_ins,
    n_tup_upd,
    n_tup_del
FROM pg_stat_user_tables 
WHERE relname = 'Assets';

-- Query optimization hints for common patterns
COMMENT ON INDEX idx_assets_volume_24h_desc IS 
'Primary index for volume-based sorting. Use for: ORDER BY quoteVolume24h DESC';

COMMENT ON INDEX idx_assets_status_volume IS 
'Composite index for status filtering with volume sorting. Use for: WHERE status = ? ORDER BY quoteVolume24h';

COMMENT ON INDEX idx_assets_symbol_text_search IS 
'Text search index for symbol/name searches. Use for: WHERE symbol ILIKE ? OR name ILIKE ?';

COMMENT ON INDEX idx_assets_trading_comprehensive IS 
'Partial index covering most trading queries. Automatically used for active trading pairs.';

-- Database configuration recommendations
-- Add these to postgresql.conf for optimal performance:
/*
-- Memory settings (adjust based on available RAM)
shared_buffers = 256MB                  -- 25% of RAM
effective_cache_size = 1GB              -- 75% of RAM  
work_mem = 16MB                         -- For sorting/hashing
maintenance_work_mem = 256MB            -- For index creation

-- Query planner settings
random_page_cost = 1.1                  -- For SSD storage
effective_io_concurrency = 200          -- For SSD
seq_page_cost = 1.0

-- WAL settings for write performance
wal_buffers = 16MB
checkpoint_completion_target = 0.9
checkpoint_timeout = 15min

-- Statistics collection
default_statistics_target = 100         -- Better query planning
track_io_timing = on                    -- Performance monitoring
*/

-- Performance validation queries
-- Use these to verify index effectiveness:

-- 1. Check index usage
-- SELECT * FROM v_assets_index_usage;

-- 2. Check query performance
-- SELECT * FROM v_assets_query_performance;

-- 3. Test volume-based sorting (should use idx_assets_volume_24h_desc)
-- EXPLAIN (ANALYZE, BUFFERS) 
-- SELECT * FROM "Assets" WHERE status = 'TRADING' ORDER BY "quoteVolume24h" DESC LIMIT 20;

-- 4. Test text search (should use idx_assets_symbol_text_search)
-- EXPLAIN (ANALYZE, BUFFERS)
-- SELECT * FROM "Assets" WHERE symbol ILIKE '%BTC%' OR name ILIKE '%Bitcoin%';

-- 5. Test composite filtering (should use idx_assets_status_volume)
-- EXPLAIN (ANALYZE, BUFFERS)
-- SELECT * FROM "Assets" WHERE status = 'TRADING' AND "quoteVolume24h" > 100000 
-- ORDER BY "quoteVolume24h" DESC LIMIT 20;