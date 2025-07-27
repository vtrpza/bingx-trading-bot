import { logger } from './logger';

/**
 * Utility functions for symbol validation and normalization
 */

/**
 * Normalize and validate a trading symbol
 * Fixes common issues like DOT-VST-USDT -> DOT-USDT
 */
export function normalizeSymbol(symbol: string): string {
  if (!symbol) {
    throw new Error('Symbol is required');
  }
  
  // Convert to uppercase and normalize format
  let normalizedSymbol = symbol.toUpperCase().replace(/[\/\\]/g, '-');
  
  // Log original symbol for debugging if it contains VST
  if (normalizedSymbol.includes('VST')) {
    logger.debug('Normalizing symbol with VST:', { 
      original: symbol, 
      normalized: normalizedSymbol 
    });
  }
  
  // Fix the specific DOT-VST-USDT issue by removing incorrect VST insertion
  normalizedSymbol = normalizedSymbol.replace(/-VST-USDT$/i, '-USDT');
  normalizedSymbol = normalizedSymbol.replace(/-VST-USDC$/i, '-USDC');
  
  // Remove any duplicate VST patterns that might exist
  normalizedSymbol = normalizedSymbol.replace(/(-VST)+/gi, '');
  
  // Remove any trailing -VST-USDT, -VST-USDC patterns (additional safety)
  normalizedSymbol = normalizedSymbol.replace(/-VST-(USDT|USDC)$/, '-$1');
  
  // Log if we made changes
  if (symbol !== normalizedSymbol) {
    logger.info('Symbol normalized:', { 
      original: symbol, 
      normalized: normalizedSymbol 
    });
  }
  
  return normalizedSymbol;
}

/**
 * Validate and format symbol with proper suffix
 */
export function validateAndFormatSymbol(symbol: string): string {
  if (!symbol) {
    throw new Error('Symbol is required');
  }
  
  // First normalize the symbol
  let cleanedSymbol = normalizeSymbol(symbol);
  
  // Check if symbol already has proper suffix
  if (cleanedSymbol.endsWith('-USDT') || cleanedSymbol.endsWith('-USDC')) {
    return cleanedSymbol;
  }
  
  // Remove existing suffix if any (for conversion)
  const baseSymbol = cleanedSymbol.replace(/-(USDT|USDC|VST)$/, '');
  
  // Add default USDT suffix if no suffix provided
  return `${baseSymbol}-USDT`;
}

/**
 * Extract base symbol (without suffix)
 */
export function getBaseSymbol(symbol: string): string {
  const normalized = normalizeSymbol(symbol);
  return normalized.replace(/-(USDT|USDC|VST)$/, '');
}

/**
 * Check if symbol appears to be valid format
 */
export function isValidSymbolFormat(symbol: string): boolean {
  try {
    const normalized = normalizeSymbol(symbol);
    // Should contain at least one character followed by a valid suffix
    return /^[A-Z0-9]+-(?:USDT|USDC)$/.test(normalized);
  } catch {
    return false;
  }
}

/**
 * Batch normalize multiple symbols
 */
export function normalizeSymbols(symbols: string[]): string[] {
  return symbols.map(symbol => {
    try {
      return normalizeSymbol(symbol);
    } catch (error) {
      logger.warn('Failed to normalize symbol:', { symbol, error });
      return symbol; // Return original if normalization fails
    }
  });
}