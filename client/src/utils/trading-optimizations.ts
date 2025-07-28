/**
 * Otimizações de performance para cálculos de trading em tempo real
 * Motor robusto e eficiente para processamento de dados financeiros
 */

// Cache para indicadores técnicos com TTL
interface CacheEntry<T> {
  value: T
  timestamp: number
  ttl: number
}

class IndicatorCache<T> {
  private cache = new Map<string, CacheEntry<T>>()
  private defaultTTL: number

  constructor(defaultTTL = 30000) { // 30 segundos default
    this.defaultTTL = defaultTTL
  }

  set(key: string, value: T, ttl?: number): void {
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      ttl: ttl || this.defaultTTL
    })
  }

  get(key: string): T | null {
    const entry = this.cache.get(key)
    if (!entry) return null

    const now = Date.now()
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key)
      return null
    }

    return entry.value
  }

  clear(): void {
    this.cache.clear()
  }

  cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key)
      }
    }
  }
}

// Cache global para indicadores técnicos
export const indicatorCache = new IndicatorCache()

// Pool de objetos para evitar garbage collection
class ObjectPool<T> {
  private pool: T[] = []
  private createFn: () => T
  private resetFn?: (obj: T) => void

  constructor(createFn: () => T, resetFn?: (obj: T) => void, initialSize = 10) {
    this.createFn = createFn
    this.resetFn = resetFn
    
    // Pré-alocar objetos
    for (let i = 0; i < initialSize; i++) {
      this.pool.push(this.createFn())
    }
  }

  acquire(): T {
    return this.pool.pop() || this.createFn()
  }

  release(obj: T): void {
    if (this.resetFn) {
      this.resetFn(obj)
    }
    this.pool.push(obj)
  }
}

// Pool para objetos de análise de sinais
interface SignalAnalysis {
  signal: 'BUY' | 'SELL' | 'NEUTRAL'
  confidence: number
  reason: string
}

export const signalAnalysisPool = new ObjectPool<SignalAnalysis>(
  () => ({ signal: 'NEUTRAL', confidence: 0, reason: '' }),
  (obj) => {
    obj.signal = 'NEUTRAL'
    obj.confidence = 0
    obj.reason = ''
  }
)

/**
 * Cálculo otimizado de RSI usando algoritmo incremental
 */
export class FastRSI {
  private period: number
  private gains: number[] = []
  private losses: number[] = []
  private avgGain = 0
  private avgLoss = 0
  private lastPrice = 0
  private isInitialized = false

  constructor(period = 14) {
    this.period = period
  }

  update(price: number): number | null {
    if (!this.isInitialized) {
      this.lastPrice = price
      this.isInitialized = true
      return null
    }

    const change = price - this.lastPrice
    const gain = change > 0 ? change : 0
    const loss = change < 0 ? -change : 0

    this.gains.push(gain)
    this.losses.push(loss)

    if (this.gains.length > this.period) {
      this.gains.shift()
      this.losses.shift()
    }

    if (this.gains.length < this.period) {
      this.lastPrice = price
      return null
    }

    // Cálculo otimizado da média
    if (this.avgGain === 0 && this.avgLoss === 0) {
      // Primeira inicialização
      this.avgGain = this.gains.reduce((sum, val) => sum + val, 0) / this.period
      this.avgLoss = this.losses.reduce((sum, val) => sum + val, 0) / this.period
    } else {
      // Cálculo incremental (Wilder's smoothing)
      this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period
      this.avgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period
    }

    this.lastPrice = price

    if (this.avgLoss === 0) return 100
    const rs = this.avgGain / this.avgLoss
    return 100 - (100 / (1 + rs))
  }

  reset(): void {
    this.gains = []
    this.losses = []
    this.avgGain = 0
    this.avgLoss = 0
    this.lastPrice = 0
    this.isInitialized = false
  }
}

/**
 * Cálculo otimizado de SMA usando buffer circular
 */
export class FastSMA {
  private period: number
  private values: number[] = []
  private sum = 0
  private index = 0
  private count = 0

  constructor(period: number) {
    this.period = period
    this.values = new Array(period).fill(0)
  }

  update(value: number): number | null {
    const oldValue = this.values[this.index]
    this.values[this.index] = value

    this.sum = this.sum - oldValue + value
    this.index = (this.index + 1) % this.period
    this.count = Math.min(this.count + 1, this.period)

    return this.count < this.period ? null : this.sum / this.period
  }

  reset(): void {
    this.values.fill(0)
    this.sum = 0
    this.index = 0
    this.count = 0
  }
}

/**
 * Detector de spikes de volume otimizado
 */
export class VolumeSpikeDetector {
  private recentVolumes: number[] = []
  private maxHistory: number

  constructor(maxHistory = 20) {
    this.maxHistory = maxHistory
  }

  detectSpike(currentVolume: number, threshold = 2.0): boolean {
    if (this.recentVolumes.length === 0) {
      this.recentVolumes.push(currentVolume)
      return false
    }

    const avgVolume = this.recentVolumes.reduce((sum, vol) => sum + vol, 0) / this.recentVolumes.length
    const isSpike = currentVolume >= avgVolume * threshold

    // Manter histórico limitado
    this.recentVolumes.push(currentVolume)
    if (this.recentVolumes.length > this.maxHistory) {
      this.recentVolumes.shift()
    }

    return isSpike
  }

  reset(): void {
    this.recentVolumes = []
  }
}

/**
 * Calculadora de distância entre médias móveis otimizada
 */
export const calculateMADistance = (ma1: number, ma2: number): number => {
  return ((ma1 - ma2) / ma2) * 100
}

/**
 * Validador de RSI otimizado
 */
export const isRSIValid = (rsi: number, min = 35, max = 73): boolean => {
  return rsi >= min && rsi <= max
}

/**
 * Detecção de cruzamento de médias móveis
 */
export const detectMACrossover = (
  currentMA1: number,
  currentMA2: number,
  previousMA1: number,
  previousMA2: number
): 'BULLISH' | 'BEARISH' | 'NONE' => {
  const currentAbove = currentMA1 > currentMA2
  const previousAbove = previousMA1 > previousMA2

  if (currentAbove && !previousAbove) return 'BULLISH'
  if (!currentAbove && previousAbove) return 'BEARISH'
  return 'NONE'
}

/**
 * Formatadores otimizados com cache
 */
const formatterCache = {
  price: new Map<number, string>(),
  volume: new Map<number, string>(),
  percentage: new Map<number, string>()
}

export const formatPrice = (price: number | null | undefined): string => {
  if (!price) return 'N/A'
  
  const cached = formatterCache.price.get(price)
  if (cached) return cached

  const formatted = `$${price.toFixed(4)}`
  formatterCache.price.set(price, formatted)
  return formatted
}

export const formatVolume = (volume: number | null | undefined): string => {
  if (!volume) return 'N/A'
  
  const cached = formatterCache.volume.get(volume)
  if (cached) return cached

  let formatted: string
  if (volume >= 1000000) {
    formatted = `${(volume / 1000000).toFixed(1)}M`
  } else if (volume >= 1000) {
    formatted = `${(volume / 1000).toFixed(1)}K`
  } else {
    formatted = volume.toString()
  }

  formatterCache.volume.set(volume, formatted)
  return formatted
}

export const formatPercentage = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return 'N/A'
  
  const cached = formatterCache.percentage.get(value)
  if (cached) return cached

  const formatted = `${value.toFixed(2)}%`
  formatterCache.percentage.set(value, formatted)
  return formatted
}

/**
 * Limpeza periódica dos caches para evitar vazamentos de memória
 */
export const cleanupCaches = (): void => {
  indicatorCache.cleanup()
  
  // Limpar caches de formatadores se ficarem muito grandes
  if (formatterCache.price.size > 1000) {
    formatterCache.price.clear()
  }
  if (formatterCache.volume.size > 1000) {
    formatterCache.volume.clear()
  }
  if (formatterCache.percentage.size > 1000) {
    formatterCache.percentage.clear()
  }
}

// Auto-limpeza a cada 5 minutos
setInterval(cleanupCaches, 5 * 60 * 1000)