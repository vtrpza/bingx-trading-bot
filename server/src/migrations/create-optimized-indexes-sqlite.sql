-- SQLite-optimized database indexes for financial data optimization
-- Optimized for the AssetsPage data flow and trading bot operations

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
CREATE INDEX idx_assets_volume_24h_desc 
ON Assets (quoteVolume24h DESC) 
WHERE status = 'TRADING';

-- 2. Price change index for gainers/losers queries
CREATE INDEX idx_assets_price_change_desc 
ON Assets (priceChangePercent DESC) 
WHERE status = 'TRADING';

-- 3. Composite index for status + volume filtering (covers most frontend queries)
CREATE INDEX idx_assets_status_volume 
ON Assets (status, quoteVolume24h DESC);

-- 4. Multi-column index for pagination queries
CREATE INDEX idx_assets_composite_filter 
ON Assets (status, updatedAt DESC, quoteVolume24h DESC) 
WHERE status IN ('TRADING', 'SUSPENDED', 'DELISTED');

-- 5. Text search index for symbol and name searches (SQLite FTS)
-- Note: SQLite doesn't have trigram support, using standard text index
CREATE INDEX idx_assets_symbol_search ON Assets (symbol);
CREATE INDEX idx_assets_name_search ON Assets (name);

-- 6. Time-based index for recent updates
CREATE INDEX idx_assets_updated_at 
ON Assets (updatedAt DESC);

-- 7. Partial index for active trading pairs only (most queried subset)
CREATE INDEX idx_assets_trading_comprehensive
ON Assets (quoteVolume24h DESC, priceChangePercent DESC, updatedAt DESC) 
WHERE status = 'TRADING' AND quoteVolume24h > 0;

-- 8. Index for leverage-based queries (trading bot specific)
CREATE INDEX idx_assets_leverage_risk
ON Assets (maxLeverage, maintMarginRate) 
WHERE status = 'TRADING';

-- 9. Specialized index for price range queries
CREATE INDEX idx_assets_price_range
ON Assets (lastPrice, highPrice24h, lowPrice24h) 
WHERE status = 'TRADING' AND lastPrice > 0;

-- 10. Index for open interest analysis
CREATE INDEX idx_assets_open_interest
ON Assets (openInterest DESC) 
WHERE status = 'TRADING' AND openInterest > 0;

-- Update table statistics (SQLite equivalent)
ANALYZE Assets;

-- Performance validation queries for SQLite
-- Use these to verify index effectiveness:

-- 1. Test volume-based sorting (should use idx_assets_volume_24h_desc)
-- EXPLAIN QUERY PLAN SELECT * FROM Assets WHERE status = 'TRADING' ORDER BY quoteVolume24h DESC LIMIT 20;

-- 2. Test text search (should use idx_assets_symbol_search or idx_assets_name_search)
-- EXPLAIN QUERY PLAN SELECT * FROM Assets WHERE symbol LIKE '%BTC%' OR name LIKE '%Bitcoin%';

-- 3. Test composite filtering (should use idx_assets_status_volume)
-- EXPLAIN QUERY PLAN SELECT * FROM Assets WHERE status = 'TRADING' AND quoteVolume24h > 100000 ORDER BY quoteVolume24h DESC LIMIT 20;