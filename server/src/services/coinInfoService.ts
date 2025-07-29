import axios from 'axios';
import { logger } from '../utils/logger';

interface CoinGeckoSimpleResponse {
  [key: string]: {
    name: string;
    symbol: string;
  };
}

class CoinInfoService {
  private static coinCache = new Map<string, string>();
  private static lastFetch = 0;
  private static readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
  
  /**
   * Busca nomes de moedas da API CoinGecko
   */
  static async getCoinNames(symbols: string[]): Promise<{ [key: string]: string }> {
    try {
      // Check if we need to refresh cache
      const now = Date.now();
      if (now - this.lastFetch > this.CACHE_DURATION || this.coinCache.size === 0) {
        await this.refreshCoinCache();
      }
      
      const result: { [key: string]: string } = {};
      
      for (const symbol of symbols) {
        const cleanSymbol = symbol.replace('-USDT', '').replace('-USDC', '').replace('-BTC', '').toUpperCase();
        const coinName = this.coinCache.get(cleanSymbol);
        result[symbol] = coinName || symbol;
      }
      
      return result;
      
    } catch (error) {
      logger.error('Error fetching coin names:', error);
      // Return symbols as fallback
      const fallback: { [key: string]: string } = {};
      symbols.forEach(symbol => {
        fallback[symbol] = symbol;
      });
      return fallback;
    }
  }
  
  /**
   * Atualiza o cache com dados da CoinGecko
   */
  private static async refreshCoinCache(): Promise<void> {
    try {
      logger.info('🪙 Refreshing coin names cache from CoinGecko...');
      
      // Busca lista de todas as moedas (limitado a top 5000 para performance)
      const response = await axios.get('https://api.coingecko.com/api/v3/coins/list', {
        timeout: 30000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'BingX-Trading-Bot/1.0'
        }
      });
      
      if (response.data && Array.isArray(response.data)) {
        this.coinCache.clear();
        
        response.data.forEach((coin: any) => {
          if (coin.symbol && coin.name) {
            this.coinCache.set(coin.symbol.toUpperCase(), coin.name);
          }
        });
        
        this.lastFetch = Date.now();
        logger.info(`✅ Coin names cache updated: ${this.coinCache.size} coins loaded`);
      }
      
    } catch (error) {
      logger.error('Failed to refresh coin cache:', error);
      
      // Fallback: add common coins manually if API fails
      if (this.coinCache.size === 0) {
        this.addFallbackCoins();
      }
    }
  }
  
  /**
   * Adiciona moedas mais comuns como fallback
   */
  private static addFallbackCoins(): void {
    const commonCoins = {
      'BTC': 'Bitcoin',
      'ETH': 'Ethereum',
      'BNB': 'BNB',
      'ADA': 'Cardano',
      'SOL': 'Solana',
      'XRP': 'XRP',
      'DOT': 'Polkadot',
      'DOGE': 'Dogecoin',
      'AVAX': 'Avalanche',
      'SHIB': 'Shiba Inu',
      'LTC': 'Litecoin',
      'MATIC': 'Polygon',
      'UNI': 'Uniswap',
      'LINK': 'Chainlink',
      'BCH': 'Bitcoin Cash',
      'ALGO': 'Algorand',
      'VET': 'VeChain',
      'ICP': 'Internet Computer',
      'FIL': 'Filecoin',
      'TRX': 'TRON'
    };
    
    Object.entries(commonCoins).forEach(([symbol, name]) => {
      this.coinCache.set(symbol, name);
    });
    
    logger.info(`📝 Fallback coin names loaded: ${this.coinCache.size} coins`);
  }
  
  /**
   * Retorna informações de cache
   */
  static getCacheInfo() {
    return {
      size: this.coinCache.size,
      lastFetch: this.lastFetch,
      age: Date.now() - this.lastFetch
    };
  }
}

export default CoinInfoService;