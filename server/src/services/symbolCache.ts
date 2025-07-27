import { bingxClient } from './bingxClient';
import { logger } from '../utils/logger';

interface SymbolInfo {
  symbol: string;
  asset: string;
  status: number;
  displayName: string;
  pricePrecision: number;
  quantityPrecision: number;
}

export class SymbolCache {
  private symbols: Map<string, SymbolInfo> = new Map();
  private lastUpdate: number = 0;
  private readonly CACHE_DURATION = 3600000; // 1 hour
  private updating: boolean = false;

  /**
   * Get all valid symbols from cache
   */
  async getValidSymbols(): Promise<string[]> {
    await this.ensureCache();
    return Array.from(this.symbols.keys()).filter(symbol => {
      const info = this.symbols.get(symbol);
      return info && info.status === 1; // Only active symbols
    });
  }

  /**
   * Check if a symbol exists and is active
   */
  async isValidSymbol(symbol: string): Promise<boolean> {
    await this.ensureCache();
    const info = this.symbols.get(symbol.toUpperCase());
    return info !== undefined && info.status === 1;
  }

  /**
   * Get symbol info
   */
  async getSymbolInfo(symbol: string): Promise<SymbolInfo | null> {
    await this.ensureCache();
    return this.symbols.get(symbol.toUpperCase()) || null;
  }

  /**
   * Find similar symbols (fuzzy search)
   */
  async findSimilarSymbols(input: string, maxResults: number = 5): Promise<string[]> {
    await this.ensureCache();
    const searchTerm = input.toUpperCase();
    const activeSymbols = Array.from(this.symbols.entries())
      .filter(([_, info]) => info.status === 1)
      .map(([symbol]) => symbol);

    // Exact match first
    if (activeSymbols.includes(searchTerm)) {
      return [searchTerm];
    }

    // Find symbols that contain the search term
    const matches = activeSymbols.filter(symbol => 
      symbol.includes(searchTerm) || 
      symbol.replace('-USDT', '').includes(searchTerm.replace('-USDT', ''))
    );

    // Sort by relevance (shorter matches first, exact asset matches)
    matches.sort((a, b) => {
      const aAsset = a.replace('-USDT', '');
      const bAsset = b.replace('-USDT', '');
      const searchAsset = searchTerm.replace('-USDT', '');

      // Exact asset match gets priority
      if (aAsset === searchAsset && bAsset !== searchAsset) return -1;
      if (bAsset === searchAsset && aAsset !== searchAsset) return 1;

      // Then by length (shorter = more relevant)
      return a.length - b.length;
    });

    return matches.slice(0, maxResults);
  }

  /**
   * Validate and suggest corrections for invalid symbols
   */
  async validateSymbolWithSuggestions(input: string): Promise<{
    isValid: boolean;
    symbol?: string;
    suggestions?: string[];
    message?: string;
  }> {
    const normalizedInput = input.toUpperCase().replace(/[/\\]/g, '-');
    
    // Add -USDT if not present
    let testSymbol = normalizedInput;
    if (!testSymbol.endsWith('-USDT') && !testSymbol.endsWith('-USDC')) {
      testSymbol = `${testSymbol}-USDT`;
    }

    // Check if valid
    if (await this.isValidSymbol(testSymbol)) {
      return {
        isValid: true,
        symbol: testSymbol
      };
    }

    // Find suggestions
    const suggestions = await this.findSimilarSymbols(normalizedInput);
    
    if (suggestions.length > 0) {
      return {
        isValid: false,
        suggestions,
        message: `Symbol "${input}" not found. Did you mean: ${suggestions.slice(0, 3).join(', ')}?`
      };
    }

    return {
      isValid: false,
      message: `Symbol "${input}" not found and no similar symbols available.`
    };
  }

  /**
   * Get popular trading symbols dynamically
   */
  async getPopularSymbols(limit: number = 10): Promise<string[]> {
    await this.ensureCache();
    
    // Get symbols sorted by some criteria (for now, just get active USDT pairs)
    const usdtSymbols = Array.from(this.symbols.entries())
      .filter(([symbol, info]) => 
        info.status === 1 && 
        symbol.endsWith('-USDT') &&
        // Prioritize major coins
        ['BTC', 'ETH', 'BNB', 'ADA', 'XRP', 'DOGE', 'SOL', 'DOT', 'LINK', 'AVAX', 'ATOM', 'NEAR', 'POL'].some(major => 
          symbol.startsWith(major + '-')
        )
      )
      .map(([symbol]) => symbol)
      .slice(0, limit);

    return usdtSymbols;
  }

  /**
   * Force refresh the symbol cache
   */
  async refreshCache(): Promise<void> {
    if (this.updating) {
      logger.debug('Symbol cache update already in progress');
      return;
    }

    this.updating = true;
    
    try {
      logger.info('Refreshing symbol cache from BingX API...');
      const response = await bingxClient.getSymbols();
      
      if (response.code !== 0 || !response.data) {
        throw new Error(`Failed to fetch symbols: ${response.msg || 'Unknown error'}`);
      }

      // Clear and rebuild cache
      this.symbols.clear();
      
      for (const symbolData of response.data) {
        if (symbolData.symbol) {
          this.symbols.set(symbolData.symbol.toUpperCase(), {
            symbol: symbolData.symbol,
            asset: symbolData.asset || symbolData.symbol.split('-')[0],
            status: symbolData.status || 0,
            displayName: symbolData.displayName || symbolData.symbol,
            pricePrecision: symbolData.pricePrecision || 4,
            quantityPrecision: symbolData.quantityPrecision || 4
          });
        }
      }

      this.lastUpdate = Date.now();
      
      logger.info(`Symbol cache refreshed: ${this.symbols.size} symbols loaded`, {
        activeSymbols: Array.from(this.symbols.values()).filter(s => s.status === 1).length,
        totalSymbols: this.symbols.size
      });

    } catch (error) {
      logger.error('Failed to refresh symbol cache:', error);
      // Don't clear existing cache on error, keep using stale data
      throw error;
    } finally {
      this.updating = false;
    }
  }

  /**
   * Ensure cache is fresh (auto-refresh if needed)
   */
  private async ensureCache(): Promise<void> {
    const now = Date.now();
    const cacheAge = now - this.lastUpdate;
    
    // If cache is empty or expired, refresh it
    if (this.symbols.size === 0 || cacheAge > this.CACHE_DURATION) {
      await this.refreshCache();
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const activeSymbols = Array.from(this.symbols.values()).filter(s => s.status === 1).length;
    
    return {
      totalSymbols: this.symbols.size,
      activeSymbols,
      lastUpdate: this.lastUpdate,
      cacheAge: Date.now() - this.lastUpdate,
      isStale: (Date.now() - this.lastUpdate) > this.CACHE_DURATION
    };
  }
}

// Global instance
export const symbolCache = new SymbolCache();