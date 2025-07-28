/**
 * Motor Otimizado de Processamento de Dados de Trading
 * Sistema de alta performance para análise de sinais em tempo real
 * 
 * Melhorias implementadas:
 * - Cache inteligente com particionamento
 * - Pool de objetos para reduzir GC
 * - Algoritmos incrementais otimizados
 * - Processamento paralelo avançado
 * - Estruturas de dados eficientes
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
  private maxSize: number
  private hitCount = 0
  private missCount = 0

  constructor(defaultTTL = 30000, maxSize = 1000) {
    this.defaultTTL = defaultTTL
    this.maxSize = maxSize
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
    if (!entry) {
      this.missCount++
      return null
    }

    const now = Date.now()
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key)
      this.missCount++
      return null
    }

    this.hitCount++
    return entry.value
  }

  clear(): void {
    this.cache.clear()
  }

  cleanup(): void {
    const now = Date.now()
    
    // LRU eviction se cache muito grande
    if (this.cache.size > this.maxSize) {
      const sortedEntries = Array.from(this.cache.entries())
        .sort(([,a], [,b]) => a.timestamp - b.timestamp)
      
      // Remove 20% dos itens mais antigos
      const toRemove = Math.floor(this.maxSize * 0.2)
      for (let i = 0; i < toRemove; i++) {
        this.cache.delete(sortedEntries[i][0])
      }
    }
    
    // Remove itens expirados
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key)
      }
    }
  }

  getStats() {
    const total = this.hitCount + this.missCount
    return {
      hitRate: total > 0 ? (this.hitCount / total * 100).toFixed(1) : '0',
      size: this.cache.size,
      maxSize: this.maxSize
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

/**
 * Sistema de Processamento Paralelo Ultra-Otimizado para Múltiplos Timeframes
 * Melhorias de performance:
 * - Processamento em lotes (batching)
 * - Pool de conexões HTTP
 * - Cache pré-aquecido
 * - Lazy loading inteligente
 */
export class ParallelTimeframeProcessor {
  private processingQueue = new Map<string, Promise<any>>()
  private maxConcurrent = 8 // Aumentado para melhor paralelismo
  private activeRequests = 0
  private batchQueue: Array<{ symbol: string, timeframes: string[], resolve: Function, reject: Function }> = []
  private batchTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly BATCH_SIZE = 6 // Processar 6 símbolos por vez
  private readonly BATCH_DELAY = 100 // 100ms para formar lotes

  async processSymbol(symbol: string, timeframes: string[]): Promise<any[]> {
    const queueKey = `${symbol}-${timeframes.join(',')}`
    
    // Evitar processamento duplicado
    if (this.processingQueue.has(queueKey)) {
      return this.processingQueue.get(queueKey)!
    }

    // Usar batching para otimizar requisições
    const processingPromise = new Promise<any[]>((resolve, reject) => {
      this.batchQueue.push({ symbol, timeframes, resolve, reject })
      this.scheduleBatchProcessing()
    })

    this.processingQueue.set(queueKey, processingPromise)

    try {
      const results = await processingPromise
      return results
    } finally {
      this.processingQueue.delete(queueKey)
    }
  }

  private scheduleBatchProcessing(): void {
    if (this.batchTimeout) return

    this.batchTimeout = setTimeout(() => {
      this.processBatch()
      this.batchTimeout = null
    }, this.BATCH_DELAY)

    // Forçar processamento se lote estiver cheio
    if (this.batchQueue.length >= this.BATCH_SIZE) {
      clearTimeout(this.batchTimeout)
      this.batchTimeout = null
      this.processBatch()
    }
  }

  private async processBatch(): Promise<void> {
    if (this.batchQueue.length === 0) return

    const batch = this.batchQueue.splice(0, this.BATCH_SIZE)
    
    // Processar lote em paralelo
    const batchPromises = batch.map(async (item) => {
      try {
        const result = await this.executeTimeframeRequests(item.symbol, item.timeframes)
        item.resolve(result)
      } catch (error) {
        item.reject(error)
      }
    })

    await Promise.all(batchPromises)
    
    // Continuar processando se houver mais itens na fila
    if (this.batchQueue.length > 0) {
      setTimeout(() => this.processBatch(), 50)
    }
  }

  private async executeTimeframeRequests(symbol: string, timeframes: string[]): Promise<any[]> {
    // Aguardar slot disponível com timeout
    const maxWaitTime = 5000 // 5 segundos máximo
    const startTime = Date.now()
    
    while (this.activeRequests >= this.maxConcurrent) {
      if (Date.now() - startTime > maxWaitTime) {
        throw new Error(`Timeout waiting for processing slot for ${symbol}`)
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    this.activeRequests++
    
    try {
      // Usar AbortController para timeout das requisições
      const abortController = new AbortController()
      const timeoutId = setTimeout(() => abortController.abort(), 8000) // 8s timeout
      
      const promises = timeframes.map(interval => {
        const cacheKey = `${symbol}-${interval}-${Math.floor(Date.now() / 30000)}` // Cache por 30s
        const cached = indicatorCache.get(cacheKey)
        
        if (cached) {
          return Promise.resolve(cached)
        }
        
        return fetch(`/api/trading/candles/${symbol}?interval=${interval}&limit=50`, {
          signal: abortController.signal,
          headers: {
            'Accept': 'application/json',
            'Cache-Control': 'max-age=30'
          }
        })
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status} for ${symbol}-${interval}`)
          return r.json()
        })
        .then(data => {
          indicatorCache.set(cacheKey, data, 30000) // Cache por 30s
          return data
        })
      })
      
      const results = await Promise.all(promises)
      clearTimeout(timeoutId)
      return results
    } finally {
      this.activeRequests--
    }
  }

  // Método para pré-aquecer cache com símbolos prioritários
  async preloadSymbols(symbols: string[], timeframes: string[]): Promise<void> {
    const prioritySymbols = symbols.slice(0, 12) // Pré-carregar apenas os 12 primeiros
    const preloadPromises = prioritySymbols.map(symbol => 
      this.processSymbol(symbol, timeframes).catch(error => {
        console.warn(`Preload failed for ${symbol}:`, error.message)
        return null
      })
    )
    
    await Promise.allSettled(preloadPromises)
  }
}

/**
 * Calculadora de Distância de Médias Móveis Otimizada
 */
export class OptimizedMADistanceCalculator {
  private static readonly DISTANCE_PRECISION = 2
  private static readonly distanceCache = new Map<string, number>()

  static calculate(ma1: number, center: number): number {
    if (!ma1 || !center || center === 0) return 0
    
    const cacheKey = `${ma1.toFixed(6)}-${center.toFixed(6)}`
    
    if (this.distanceCache.has(cacheKey)) {
      return this.distanceCache.get(cacheKey)!
    }

    const distance = Number((((ma1 - center) / center) * 100).toFixed(this.DISTANCE_PRECISION))
    
    // Manter cache limitado
    if (this.distanceCache.size > 500) {
      const keysToDelete = Array.from(this.distanceCache.keys()).slice(0, 100)
      keysToDelete.forEach(key => this.distanceCache.delete(key))
    }
    
    this.distanceCache.set(cacheKey, distance)
    return distance
  }

  static getSignalDirection(distance: number, threshold = 2): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    if (distance >= threshold) return 'BULLISH'
    if (distance <= -threshold) return 'BEARISH'
    return 'NEUTRAL'
  }
}

/**
 * Detector de Volume Spike Altamente Otimizado
 */
export class HighPerformanceVolumeDetector {
  private static readonly volumeHistory = new Map<string, number[]>()
  private static readonly MAX_HISTORY = 20

  static detectSpike(symbol: string, currentVolume: number, spikeThreshold = 2.0): {
    isSpike: boolean
    ratio: number
    level: 'NORMAL' | 'ELEVATED' | 'SPIKE'
  } {
    if (!this.volumeHistory.has(symbol)) {
      this.volumeHistory.set(symbol, [])
    }

    const history = this.volumeHistory.get(symbol)!
    
    if (history.length === 0) {
      history.push(currentVolume)
      return { isSpike: false, ratio: 1, level: 'NORMAL' }
    }

    // Calcular média usando média móvel exponencial para eficiência
    const avgVolume = history.reduce((sum, vol) => sum + vol, 0) / history.length
    const ratio = currentVolume / avgVolume

    // Atualizar histórico
    history.push(currentVolume)
    if (history.length > this.MAX_HISTORY) {
      history.shift()
    }

    const level = ratio >= spikeThreshold ? 'SPIKE' : 
                 ratio >= 1.5 ? 'ELEVATED' : 'NORMAL'

    return {
      isSpike: ratio >= spikeThreshold,
      ratio: Number(ratio.toFixed(2)),
      level
    }
  }
}

// Instância global do processador paralelo
export const timeframeProcessor = new ParallelTimeframeProcessor()

// Auto-limpeza otimizada a cada 5 minutos
setInterval(() => {
  cleanupCaches()
  // Limpar caches estáticos periodicamente
  if (Math.random() < 0.1) { // 10% de chance a cada limpeza
    OptimizedMADistanceCalculator['distanceCache'].clear()
  }
}, 5 * 60 * 1000)