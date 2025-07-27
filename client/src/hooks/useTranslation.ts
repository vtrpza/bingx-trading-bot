import { translations } from '../locales/pt-BR'

type TranslationPath = string
type TranslationValue = string | Record<string, any>

/**
 * Hook for accessing translations
 * @param key - Translation key path (e.g., 'trading.config.title')
 * @returns Translation value or the key if not found
 */
export function useTranslation() {
  const t = (key: TranslationPath): string => {
    const keys = key.split('.')
    let value: TranslationValue = translations
    
    for (const k of keys) {
      if (typeof value === 'object' && value !== null && k in value) {
        value = value[k]
      } else {
        // Return the key if translation not found (for debugging)
        return key
      }
    }
    
    return typeof value === 'string' ? value : key
  }

  /**
   * Get crypto name from symbol
   * @param symbol - Crypto symbol (e.g., 'BTC', 'ETH')
   * @returns Full crypto name or symbol if not found
   */
  const getCryptoName = (symbol: string): string => {
    const baseSymbol = symbol.replace('-USDT', '').replace('/USDT', '').toUpperCase()
    return translations.cryptoNames[baseSymbol as keyof typeof translations.cryptoNames] || baseSymbol
  }

  return { t, getCryptoName }
}