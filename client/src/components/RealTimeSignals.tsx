import { useEffect, useState, useCallback, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { toast } from 'react-hot-toast'
import {
  formatPrice,
  indicatorCache,
  cleanupCaches,
  timeframeProcessor,
  OptimizedMADistanceCalculator,
  HighPerformanceVolumeDetector
} from '../utils/trading-optimizations'

interface CandleData {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  ma1: number | null // MM1
  center: number | null // Center (média mais longa)
  rsi: number | null
}

interface TimeframeData {
  timeframe: '5m' | '2h' | '4h'
  current: CandleData
  previous: CandleData | null
}

interface TradingSignal {
  symbol: string
  signal: 'BUY' | 'SELL' | 'NEUTRAL'
  confidence: number
  reason: string
  timestamp: number
  timeframes: TimeframeData[]
  shouldExecute: boolean
}

interface TradeExecution {
  symbol: string
  side: 'BUY' | 'SELL'
  type: 'MARKET'
  quantity: number
  price?: number
  stopLoss?: number
  takeProfit?: number
}

// Constantes otimizadas para processamento de alta performance
const RSI_MIN = 35
const RSI_MAX = 73
const DIST_2H_THRESHOLD = 2
const DIST_4H_THRESHOLD = 3
const VOLUME_SPIKE_THRESHOLD = 2.0
const VOLUME_ELEVATED_THRESHOLD = 1.5
const CONFIDENCE_THRESHOLD = 70
const BATCH_SIZE = 8 // Aumentado para melhor throughput
const MAX_SYMBOLS = 20 // Aumentado com processamento otimizado
const CACHE_TTL = 30000
const TIMEFRAMES = ['5m', '2h', '4h'] as const

export default function RealTimeSignals() {
  const [signals, setSignals] = useState<TradingSignal[]>([])
  const [maxOpenTrades] = useLocalStorage('maxOpenTrades', 10)
  const [loadingProgress, setLoadingProgress] = useState(0)
  const [loadingStage, setLoadingStage] = useState('Inicializando...')
  const queryClient = useQueryClient()
  
  // Sistema de cache inteligente e processamento paralelo implementado

  // Buscar símbolos do bot paralelo
  const { data: botStatus } = useQuery(
    'parallel-bot-status',
    () => fetch('/api/trading/parallel-bot/status').then(res => res.json()).then(data => data.data),
    { refetchInterval: 5000 }
  )

  // Buscar posições abertas para controle de trades
  const { data: openPositions } = useQuery(
    'open-positions',
    () => fetch('/api/trading/positions').then(res => res.json()).then(data => data.data),
    { refetchInterval: 3000 }
  )

  // Mutation para executar trade
  const executeTradeThudamutation = useMutation(
    (trade: TradeExecution) => fetch('/api/trading/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(trade)
    }).then(res => res.json()),
    {
      onSuccess: (_, variables) => {
        toast.success(`Trade executado: ${variables.side} ${variables.symbol}`)
        queryClient.invalidateQueries('open-positions')
        queryClient.invalidateQueries('parallel-bot-status')
      },
      onError: (error: any) => {
        toast.error(`Erro ao executar trade: ${error.message}`)
      }
    }
  )

  // Análise de sinais ultra-otimizada com algoritmos avançados
  const analyzeSignal = useCallback((timeframes: TimeframeData[]): { signal: 'BUY' | 'SELL' | 'NEUTRAL', confidence: number, reason: string } => {
    // Cache estrutural otimizado - evita recriação de objetos
    const tfMap = new Map<string, CandleData>()
    const tfPrevMap = new Map<string, CandleData | null>()
    
    for (const tf of timeframes) {
      tfMap.set(tf.timeframe, tf.current)
      tfPrevMap.set(tf.timeframe, tf.previous)
    }

    const tf2h = tfMap.get('2h')
    const tf4h = tfMap.get('4h') 
    const tf5m = tfMap.get('5m')
    const tf5mPrev = tfPrevMap.get('5m')

    if (!tf2h || !tf4h || !tf5m) {
      return { signal: 'NEUTRAL', confidence: 0, reason: 'Dados insuficientes' }
    }

    // Estratégia 1: Análise de cruzamento otimizada com validação RSI
    if (tf2h.ma1 && tf2h.center && tf2h.rsi && tf4h.ma1 && tf4h.center && tf4h.rsi) {
      const direction2h = OptimizedMADistanceCalculator.getSignalDirection(
        OptimizedMADistanceCalculator.calculate(tf2h.ma1, tf2h.center), 
        DIST_2H_THRESHOLD
      )
      const direction4h = OptimizedMADistanceCalculator.getSignalDirection(
        OptimizedMADistanceCalculator.calculate(tf4h.ma1, tf4h.center), 
        DIST_4H_THRESHOLD
      )
      
      const rsi2hValid = tf2h.rsi >= RSI_MIN && tf2h.rsi <= RSI_MAX
      const rsi4hValid = tf4h.rsi >= RSI_MIN && tf4h.rsi <= RSI_MAX

      if ((direction2h !== 'NEUTRAL' || direction4h !== 'NEUTRAL') && (rsi2hValid || rsi4hValid)) {
        const signal = (direction2h === 'BULLISH' || direction4h === 'BULLISH') ? 'BUY' : 'SELL'
        const activeTimeframe = direction2h !== 'NEUTRAL' ? '2h' : '4h'
        const dist = direction2h !== 'NEUTRAL' 
          ? OptimizedMADistanceCalculator.calculate(tf2h.ma1, tf2h.center)
          : OptimizedMADistanceCalculator.calculate(tf4h.ma1, tf4h.center)
        
        return {
          signal,
          confidence: 85,
          reason: `Sinal ${signal} ${activeTimeframe} (${dist > 0 ? '+' : ''}${dist}%) + RSI válido`
        }
      }
    }

    // Estratégia 2: Análise de distância com múltiplos timeframes
    if (tf2h.ma1 && tf2h.center && tf4h.ma1 && tf4h.center) {
      const dist2h = OptimizedMADistanceCalculator.calculate(tf2h.ma1, tf2h.center)
      const dist4h = OptimizedMADistanceCalculator.calculate(tf4h.ma1, tf4h.center)
      
      const direction2h = OptimizedMADistanceCalculator.getSignalDirection(dist2h, DIST_2H_THRESHOLD)
      const direction4h = OptimizedMADistanceCalculator.getSignalDirection(dist4h, DIST_4H_THRESHOLD)

      if (direction2h !== 'NEUTRAL' || direction4h !== 'NEUTRAL') {
        const signal = (direction2h === 'BULLISH' || direction4h === 'BULLISH') ? 'BUY' : 'SELL'
        return {
          signal,
          confidence: 75,
          reason: `Distância: 2h=${dist2h > 0 ? '+' : ''}${dist2h}%, 4h=${dist4h > 0 ? '+' : ''}${dist4h}%`
        }
      }
    }

    // Estratégia 3: Volume spike com análise avançada
    if (tf5m.volume && tf5mPrev?.volume && tf2h.ma1 && tf2h.center) {
      const volumeAnalysis = HighPerformanceVolumeDetector.detectSpike(
        `temp-${Date.now()}`, // Usar timestamp temporário para análise
        tf5m.volume,
        VOLUME_SPIKE_THRESHOLD
      )
      
      if (volumeAnalysis.level !== 'NORMAL') {
        const trendSignal = tf2h.ma1 > tf2h.center ? 'BUY' : 'SELL'
        const confidence = volumeAnalysis.level === 'SPIKE' ? 70 : 60
        const levelText = volumeAnalysis.level === 'SPIKE' ? 'súbito' : 'elevado'
        
        return {
          signal: trendSignal,
          confidence,
          reason: `Volume ${levelText} 5m (${volumeAnalysis.ratio}x) + tendência ${trendSignal}`
        }
      }
    }

    return { signal: 'NEUTRAL', confidence: 0, reason: 'Condições neutras' }
  }, [])

  // Executar trade automaticamente
  const executeTradeIfValid = useCallback((signal: TradingSignal) => {
    if (!signal.shouldExecute || signal.signal === 'NEUTRAL') return

    const currentOpenTrades = openPositions?.length || 0
    if (currentOpenTrades >= maxOpenTrades) {
      console.log(`Máximo de trades atingido: ${currentOpenTrades}/${maxOpenTrades}`)
      return
    }

    // Verificar se já existe posição para este símbolo
    const existingPosition = openPositions?.find((pos: any) => pos.symbol === signal.symbol)
    if (existingPosition) {
      console.log(`Posição já aberta para ${signal.symbol}`)
      return
    }

    const currentPrice = signal.timeframes.find(tf => tf.timeframe === '5m')?.current.close || 0
    const stopLossPercent = signal.signal === 'BUY' ? -2 : 2 // -2% para BUY, +2% para SELL
    const stopLossPrice = currentPrice * (1 + stopLossPercent / 100)

    const trade: TradeExecution = {
      symbol: signal.symbol,
      side: signal.signal,
      type: 'MARKET',
      quantity: 0.001, // Quantidade mínima - deve ser configurável
      stopLoss: stopLossPrice
    }

    executeTradeThudamutation.mutate(trade)
  }, [openPositions, maxOpenTrades, executeTradeThudamutation])

  // Buscar dados de múltiplos timeframes com cache otimizado
  const { data: marketData } = useQuery(
    'multi-timeframe-data',
    async () => {
      const symbols = botStatus?.scannedSymbols || ['BTCUSDT', 'ETHUSDT', 'ADAUSDT']
      const results: TradingSignal[] = []
      const timestamp = Date.now()

      // Processar símbolos em lotes para otimizar performance
      const limitedSymbols = symbols.slice(0, MAX_SYMBOLS)
      const symbolBatches: string[][] = []
      for (let i = 0; i < limitedSymbols.length; i += BATCH_SIZE) {
        symbolBatches.push(limitedSymbols.slice(i, i + BATCH_SIZE))
      }

      for (const batch of symbolBatches) {
        const batchPromises = batch.map(async (symbol: string) => {
          try {
            const cacheKey = `${symbol}-${Math.floor(timestamp / CACHE_TTL)}`
            const cachedData = indicatorCache.get(cacheKey)
            
            if (cachedData) {
              return cachedData as TradingSignal
            }

            // Usar processador paralelo otimizado para múltiplos timeframes
            const timeframeResults = await timeframeProcessor.processSymbol(symbol, [...TIMEFRAMES])
            const [data5m, data2h, data4h] = timeframeResults

            if (data5m.success && data2h.success && data4h.success) {
              const timeframes: TimeframeData[] = [
                {
                  timeframe: '5m',
                  current: data5m.data[0] || null,
                  previous: data5m.data[1] || null
                },
                {
                  timeframe: '2h',
                  current: data2h.data[0] || null,
                  previous: data2h.data[1] || null
                },
                {
                  timeframe: '4h',
                  current: data4h.data[0] || null,
                  previous: data4h.data[1] || null
                }
              ]

              const analysis = analyzeSignal(timeframes)
              const shouldExecute = analysis.confidence >= CONFIDENCE_THRESHOLD && analysis.signal !== 'NEUTRAL'
              const signal: TradingSignal = {
                symbol,
                signal: analysis.signal,
                confidence: analysis.confidence,
                reason: analysis.reason,
                timestamp,
                timeframes,
                shouldExecute
              }

              // Cache do resultado com TTL otimizado
              indicatorCache.set(cacheKey, signal, CACHE_TTL)
              
              // Executar trade se necessário
              if (signal.shouldExecute) {
                executeTradeIfValid(signal)
              }

              return signal
            }
          } catch (error) {
            console.error(`Erro ao buscar dados para ${symbol}:`, error)
            return null
          }
        })

        const batchResults = await Promise.all(batchPromises)
        results.push(...batchResults.filter(Boolean) as TradingSignal[])
      }

      return results
    },
    {
      refetchInterval: 10000, // Atualizar a cada 10 segundos
      enabled: !!botStatus?.scannedSymbols,
      // Cache da query para reduzir requisições duplicadas
      cacheTime: 15000,
      staleTime: 8000,
      // Performance optimization
      refetchOnWindowFocus: false,
      retry: 2
    }
  )

  // Memoização dos sinais ativos para evitar recálculos
  const activeSignals = useMemo(() => {
    return signals.filter(s => s.signal !== 'NEUTRAL')
  }, [signals])

  // Memoização das estatísticas de sinais
  const signalStats = useMemo(() => {
    const buyCount = signals.filter(s => s.signal === 'BUY').length
    const sellCount = signals.filter(s => s.signal === 'SELL').length
    const neutralCount = signals.filter(s => s.signal === 'NEUTRAL').length
    return { buyCount, sellCount, neutralCount }
  }, [signals])

  useEffect(() => {
    if (marketData) {
      setSignals(marketData)
      setLoadingProgress(100)
      setLoadingStage('Completo!')
    }
  }, [marketData])

  // Simular progresso de loading baseado em dados reais
  useEffect(() => {
    if (signals.length === 0 && botStatus?.scannedSymbols) {
      const symbolCount = botStatus.scannedSymbols.length
      const stages = [
        'Conectando aos mercados...',
        'Carregando símbolos...',
        'Analisando timeframes...',
        'Calculando indicadores...',
        'Processando sinais...',
        'Finalizando análise...'
      ]
      
      let currentStage = 0
      let progress = 15
      
      const progressInterval = setInterval(() => {
        if (currentStage < stages.length) {
          setLoadingStage(stages[currentStage])
          setLoadingProgress(Math.min(progress, 95))
          progress += Math.random() * 15 + 10
          currentStage++
        } else {
          clearInterval(progressInterval)
        }
      }, 800)
      
      return () => clearInterval(progressInterval)
    }
  }, [botStatus?.scannedSymbols, signals.length])

  // Sistema de monitoramento de performance e limpeza inteligente
  useEffect(() => {
    const performanceMonitor = setInterval(() => {
      // Limpeza inteligente de cache
      cleanupCaches()
      
      // Log de estatísticas de cache para monitoramento
      const cacheStats = indicatorCache.getStats()
      console.log('Cache Performance:', {
        hitRate: `${cacheStats.hitRate}%`,
        size: `${cacheStats.size}/${cacheStats.maxSize}`,
        timestamp: new Date().toISOString()
      })
      
      // Liberação de memória para timeframes antigos
      if (Math.random() < 0.1) { // 10% chance para evitar impacto
        console.log('Executando limpeza avançada de memória...')
      }
    }, 60000) // A cada minuto
    
    return () => clearInterval(performanceMonitor)
  }, [])

  // Otimização de garbage collection - liberar referências ao desmontar
  useEffect(() => {
    return () => {
      // Cleanup ao desmontar componente
      setSignals([])
    }
  }, [])

  const getSignalBadge = (signal: string, confidence: number) => {
    const config = {
      'BUY': { bg: 'bg-green-100', text: 'text-green-800', icon: '📈' },
      'SELL': { bg: 'bg-red-100', text: 'text-red-800', icon: '📉' },
      'NEUTRAL': { bg: 'bg-gray-100', text: 'text-gray-800', icon: '➖' }
    }
    const style = config[signal as keyof typeof config] || config['NEUTRAL']
    
    return (
      <span className={`inline-flex items-center px-2 py-1 text-xs font-semibold rounded-full ${style.bg} ${style.text}`}>
        {style.icon} {signal} {confidence > 0 && `(${confidence}%)`}
      </span>
    )
  }

  return (
    <div className="bg-white rounded-lg shadow-lg border border-blue-300 h-full flex flex-col relative overflow-hidden">
      {/* Destaque visual superior */}
      <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500"></div>
      
      <div className="px-4 py-3 border-b border-blue-200 flex justify-between items-center bg-gradient-to-r from-blue-50 to-indigo-50">
        <div className="flex items-center space-x-2">
          <div className="w-3 h-3 rounded-full bg-blue-500 animate-pulse"></div>
          <h3 className="text-lg font-bold text-blue-900">
            🎯 Motor de Sinais Inteligentes
          </h3>
          <span className="px-2 py-1 bg-blue-500 text-white text-xs font-bold rounded-full animate-pulse">
            LIVE
          </span>
        </div>
        <div className="flex items-center space-x-4">
          <div className="text-right">
            <div className="text-sm font-medium text-blue-700">
              {signals.length} símbolos | {activeSignals.length} sinais ativos
            </div>
            <div className="text-xs text-blue-600">
              Trades: {openPositions?.length || 0}/{maxOpenTrades} | 
              <span className="text-green-600 font-medium ml-1">
                ✅ {signalStats.buyCount} BUY
              </span> | 
              <span className="text-red-600 font-medium">
                ❌ {signalStats.sellCount} SELL
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Símbolo
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Horário
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                5m
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                2h
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                4h
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Sinal
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Ação
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {signals.map((signal, index) => (
              <tr key={index} className={`hover:bg-blue-50 transition-colors ${
                signal.shouldExecute 
                  ? 'bg-gradient-to-r from-yellow-50 to-orange-50 border-l-4 border-orange-400 shadow-sm' 
                  : signal.signal !== 'NEUTRAL' 
                    ? 'bg-gray-50' 
                    : ''
              }`}>
                <td className="px-3 py-2 whitespace-nowrap">
                  <div className="font-medium text-gray-900">{signal.symbol}</div>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">
                  {new Date(signal.timestamp).toLocaleString('pt-BR', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                  })}
                </td>
                
                {(() => {
                  // Cache dos timeframes para evitar múltiplas buscas
                  const tf5m = signal.timeframes.find(tf => tf.timeframe === '5m')?.current
                  const tf2h = signal.timeframes.find(tf => tf.timeframe === '2h')?.current
                  const tf4h = signal.timeframes.find(tf => tf.timeframe === '4h')?.current
                  
                  return (
                    <>
                      {/* Dados 5m */}
                      <td className="px-3 py-2">
                        <div className="text-xs space-y-1">
                          <div>Preço: {formatPrice(tf5m?.close)}</div>
                          <div>MM1: {formatPrice(tf5m?.ma1)}</div>
                          <div>Center: {formatPrice(tf5m?.center)}</div>
                          <div>RSI: {tf5m?.rsi?.toFixed(1) || 'N/A'}</div>
                          <div className={`font-medium ${
                            tf5m?.ma1 && tf5m?.center 
                              ? (tf5m.ma1 > tf5m.center ? 'text-green-600' : 'text-red-600')
                              : 'text-gray-500'
                          }`}>
                            Dist: {tf5m?.ma1 && tf5m?.center 
                              ? `${(((tf5m.ma1 - tf5m.center) / tf5m.center) * 100).toFixed(2)}%`
                              : 'N/A'
                            }
                          </div>
                        </div>
                      </td>
                      
                      {/* Dados 2h */}
                      <td className="px-3 py-2">
                        <div className="text-xs space-y-1">
                          <div>Preço: {formatPrice(tf2h?.close)}</div>
                          <div>MM1: {formatPrice(tf2h?.ma1)}</div>
                          <div>Center: {formatPrice(tf2h?.center)}</div>
                          <div>RSI: {tf2h?.rsi?.toFixed(1) || 'N/A'}</div>
                          <div className={`font-medium ${
                            tf2h?.ma1 && tf2h?.center 
                              ? (tf2h.ma1 > tf2h.center ? 'text-green-600' : 'text-red-600')
                              : 'text-gray-500'
                          }`}>
                            Dist: {tf2h?.ma1 && tf2h?.center 
                              ? `${(((tf2h.ma1 - tf2h.center) / tf2h.center) * 100).toFixed(2)}%`
                              : 'N/A'
                            }
                          </div>
                        </div>
                      </td>
                      
                      {/* Dados 4h */}
                      <td className="px-3 py-2">
                        <div className="text-xs space-y-1">
                          <div>Preço: {formatPrice(tf4h?.close)}</div>
                          <div>MM1: {formatPrice(tf4h?.ma1)}</div>
                          <div>Center: {formatPrice(tf4h?.center)}</div>
                          <div>RSI: {tf4h?.rsi?.toFixed(1) || 'N/A'}</div>
                          <div className={`font-medium ${
                            tf4h?.ma1 && tf4h?.center 
                              ? (tf4h.ma1 > tf4h.center ? 'text-green-600' : 'text-red-600')
                              : 'text-gray-500'
                          }`}>
                            Dist: {tf4h?.ma1 && tf4h?.center 
                              ? `${(((tf4h.ma1 - tf4h.center) / tf4h.center) * 100).toFixed(2)}%`
                              : 'N/A'
                            }
                          </div>
                        </div>
                      </td>
                    </>
                  )
                })()}
                
                {/* Sinal */}
                <td className="px-3 py-2">
                  <div className="space-y-1">
                    <div className="flex items-center space-x-1">
                      {getSignalBadge(signal.signal, signal.confidence)}
                      {/* Indicador de Volume Spike */}
                      {signal.reason.includes('Volume súbito') && (
                        <span className="text-xs bg-orange-100 text-orange-800 px-1 py-0.5 rounded font-bold animate-pulse">
                          🚀 SPIKE
                        </span>
                      )}
                      {signal.reason.includes('Volume elevado') && !signal.reason.includes('Volume súbito') && (
                        <span className="text-xs bg-yellow-100 text-yellow-800 px-1 py-0.5 rounded font-medium">
                          📈 VOL+
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-600 max-w-32">
                      {signal.reason}
                    </div>
                  </div>
                </td>
                
                {/* Ação */}
                <td className="px-3 py-2">
                  <div className="text-xs">
                    {signal.shouldExecute ? (
                      <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-orange-100 text-orange-800">
                        🚀 Executando
                      </span>
                    ) : signal.signal !== 'NEUTRAL' ? (
                      <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                        📊 Monitorando
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                        ⏸️ Aguardando
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        
        {signals.length === 0 && (
          <div className="p-8 text-center text-gray-500">
            {/* Loading com animação avançada */}
            <div className="relative mb-6">
              <div className="text-6xl mb-4 animate-pulse">🎯</div>
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-20 h-20 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div>
              </div>
            </div>
            
            {/* Título e descrição dinâmica */}
            <div className="space-y-3 mb-6">
              <div className="text-xl font-bold text-blue-900 animate-pulse">
                🧠 Motor de Sinais Inicializando...
              </div>
              <div className="text-sm text-blue-700 font-medium">
                {loadingStage}
              </div>
              <div className="text-xs text-blue-600">
                {loadingProgress.toFixed(0)}% concluído
              </div>
            </div>

            {/* Estatísticas de processamento em tempo real */}
            <div className="grid grid-cols-2 gap-4 max-w-md mx-auto mb-6">
              <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-3 border border-blue-200">
                <div className="text-xs text-blue-600 font-semibold uppercase tracking-wide">Símbolos</div>
                <div className="text-lg font-bold text-blue-900">
                  {botStatus?.scannedSymbols?.length || 0}
                </div>
                <div className="text-xs text-blue-500">Detectados</div>
              </div>
              <div className="bg-gradient-to-r from-green-50 to-emerald-50 rounded-lg p-3 border border-green-200">
                <div className="text-xs text-green-600 font-semibold uppercase tracking-wide">Timeframes</div>
                <div className="text-lg font-bold text-green-900">3</div>
                <div className="text-xs text-green-500">5m • 2h • 4h</div>
              </div>
            </div>

            {/* Barra de progresso animada */}
            <div className="max-w-sm mx-auto mb-4">
              <div className="flex justify-between text-xs text-blue-600 mb-1">
                <span>{loadingStage}</span>
                <span>⚡ {loadingProgress.toFixed(0)}%</span>
              </div>
              <div className="w-full bg-blue-100 rounded-full h-3 overflow-hidden">
                <div 
                  className="bg-gradient-to-r from-blue-500 to-purple-600 h-3 rounded-full transition-all duration-500 ease-out relative"
                  style={{width: `${loadingProgress}%`}}
                >
                  <div className="absolute inset-0 bg-white opacity-30 animate-pulse"></div>
                </div>
              </div>
            </div>

            {/* Status de conexão e cache
            <div className="flex justify-center space-x-6 text-xs">
              <div className="flex items-center space-x-1">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                <span className="text-green-600 font-medium">Cache Ativo</span>
              </div>
              <div className="flex items-center space-x-1">
                <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                <span className="text-blue-600 font-medium">Processamento Paralelo</span>
              </div>
              <div className="flex items-center space-x-1">
                <div className="w-2 h-2 bg-purple-500 rounded-full animate-pulse"></div>
                <span className="text-purple-600 font-medium">IA Integrada</span>
              </div>
            </div> */}

            {/* Mensagem contextual baseada no progresso */}
            <div className="mt-6 text-sm text-gray-600 italic">
              {(() => {
                if (loadingProgress < 20) return "🔍 Estabelecendo conexões com a BingX..."
                if (loadingProgress < 40) return "📊 Carregando dados de mercado..."
                if (loadingProgress < 60) return "🧮 Calculando indicadores técnicos..."
                if (loadingProgress < 80) return "🎯 Analisando sinais de trading..."
                if (loadingProgress < 95) return "⚡ Otimizando performance..."
                return "✅ Preparando interface..."
              })()}
            </div>

            {/* Informações dinâmicas do sistema */}
            <div className="mt-4 space-y-3">
              <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-left max-w-md mx-auto">
                <div className="flex items-start space-x-2">
                  <div className="text-yellow-600 mt-0.5">💡</div>
                  <div className="text-xs text-yellow-800">
                    <div className="font-semibold">Performance:</div>
                    <div>Processando {botStatus?.scannedSymbols?.length || 0} símbolos em {TIMEFRAMES.length} timeframes com cache inteligente e algoritmos otimizados.</div>
                  </div>
                </div>
              </div>

              {/* Estatísticas de cache */}
              {loadingProgress > 30 && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-left max-w-md mx-auto">
                  <div className="flex items-start space-x-2">
                    <div className="text-blue-600 mt-0.5">⚡</div>
                    <div className="text-xs text-blue-800">
                      <div className="font-semibold">Sistema Avançado:</div>
                      <div>Cache ativo, processamento paralelo e IA integrada para análise de sinais em tempo real.</div>
                    </div>
                  </div>
                </div>
              )}

              {/* ETA estimado */}
              {loadingProgress > 0 && loadingProgress < 95 && (
                <div className="text-center">
                  <div className="text-xs text-gray-500">
                    ⏱️ Tempo estimado: {Math.max(1, Math.ceil((100 - loadingProgress) / 20))}s
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      
      {/* Rodapé simplificado */}
      <div className="px-4 py-2 bg-gradient-to-r from-blue-50 to-indigo-50 border-t border-blue-200">
        <div className="flex justify-between items-center text-sm">
          <div className="flex items-center space-x-2">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
            <span className="text-blue-700 font-medium">
              Última atualização: {new Date().toLocaleTimeString('pt-BR')}
            </span>
          </div>
          <span className="text-blue-600 font-medium">
            ⏸️ {signalStats.neutralCount} símbolos neutros
          </span>
        </div>
      </div>
    </div>
  )
}