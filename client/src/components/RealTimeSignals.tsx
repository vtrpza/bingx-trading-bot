import { useEffect, useState, useCallback, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useWebSocket } from '../hooks/useWebSocket'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { toast } from 'react-hot-toast'
import {
  formatPrice,
  indicatorCache,
  cleanupCaches
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

// Constantes para otimização
const RSI_MIN = 35
const RSI_MAX = 73
const DIST_2H_THRESHOLD = 2
const DIST_4H_THRESHOLD = 3
const VOLUME_SPIKE_THRESHOLD = 2.0
const VOLUME_ELEVATED_THRESHOLD = 1.5
const CONFIDENCE_THRESHOLD = 70
const BATCH_SIZE = 5
const MAX_SYMBOLS = 15
const CACHE_TTL = 30000

export default function RealTimeSignals() {
  const [signals, setSignals] = useState<TradingSignal[]>([])
  const [maxOpenTrades] = useLocalStorage('maxOpenTrades', 10)
  const queryClient = useQueryClient()
  
  // Cache removido - detecção de volume agora é feita inline para melhor performance

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

  // Análise de sinais otimizada com cache de timeframes
  const analyzeSignal = useCallback((timeframes: TimeframeData[]): { signal: 'BUY' | 'SELL' | 'NEUTRAL', confidence: number, reason: string } => {
    // Cache dos timeframes para evitar múltiplas buscas
    const timeframeMap = new Map(timeframes.map(tf => [tf.timeframe, tf]))
    const tf2h = timeframeMap.get('2h')?.current
    const tf4h = timeframeMap.get('4h')?.current
    const tf5m = timeframeMap.get('5m')?.current
    const tf5mPrev = timeframeMap.get('5m')?.previous

    if (!tf2h || !tf4h || !tf5m) {
      return { signal: 'NEUTRAL', confidence: 0, reason: 'Dados insuficientes' }
    }

    // Estratégia 1: Cruzamento de MM1 com Center + RSI (otimizada)
    const has2hData = tf2h.ma1 && tf2h.center && tf2h.rsi
    const has4hData = tf4h.ma1 && tf4h.center && tf4h.rsi
    
    if (has2hData && has4hData) {
      const cross2h = tf2h.ma1! > tf2h.center!
      const cross4h = tf4h.ma1! > tf4h.center!
      const rsi2hValid = tf2h.rsi! >= RSI_MIN && tf2h.rsi! <= RSI_MAX
      const rsi4hValid = tf4h.rsi! >= RSI_MIN && tf4h.rsi! <= RSI_MAX

      if ((cross2h || cross4h) && (rsi2hValid || rsi4hValid)) {
        const signal = cross2h || cross4h ? 'BUY' : 'SELL'
        const timeframe = cross2h ? '2h' : '4h'
        return {
          signal,
          confidence: 85,
          reason: `Cruzamento MM1/Center em ${timeframe} + RSI válido`
        }
      }
    }

    // Estratégia 2: Distância MM1 vs Center (otimizada)
    const hasDistanceData = tf2h.ma1 && tf2h.center && tf4h.ma1 && tf4h.center
    
    if (hasDistanceData) {
      const dist2h = ((tf2h.ma1! - tf2h.center!) / tf2h.center!) * 100
      const dist4h = ((tf4h.ma1! - tf4h.center!) / tf4h.center!) * 100
      const absDist2h = Math.abs(dist2h)
      const absDist4h = Math.abs(dist4h)

      if (absDist2h >= DIST_2H_THRESHOLD || absDist4h >= DIST_4H_THRESHOLD) {
        const signal = (dist2h >= DIST_2H_THRESHOLD || dist4h >= DIST_4H_THRESHOLD) ? 'BUY' : 'SELL'
        return {
          signal,
          confidence: 75,
          reason: `Distância MM1/Center: 2h=${dist2h.toFixed(2)}%, 4h=${dist4h.toFixed(2)}%`
        }
      }
    }

    // Estratégia 3: Volume súbito + direção das médias (ultra-otimizada)
    const hasVolumeData = tf5m.volume && tf5mPrev?.volume && tf2h.ma1 && tf2h.center
    
    if (hasVolumeData) {
      const currentVolume = tf5m.volume!
      const previousVolume = tf5mPrev!.volume!
      const volumeRatio5m = currentVolume / previousVolume
      const trendSignal = tf2h.ma1! > tf2h.center! ? 'BUY' : 'SELL'
      
      // Volume spike otimizado - evitar cálculos desnecessários
      if (volumeRatio5m >= VOLUME_SPIKE_THRESHOLD) {
        return {
          signal: trendSignal,
          confidence: 70,
          reason: `Volume súbito 5m (${volumeRatio5m.toFixed(1)}x) + tendência ${trendSignal}`
        }
      }

      // Volume elevado - verificação otimizada
      if (tf2h.volume && volumeRatio5m >= VOLUME_ELEVATED_THRESHOLD) {
        return {
          signal: trendSignal,
          confidence: 60,
          reason: `Volume elevado + tendência ${trendSignal}`
        }
      }
    }

    return { signal: 'NEUTRAL', confidence: 0, reason: 'Nenhuma condição atendida' }
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

            // Buscar dados para os 3 timeframes
            const [data5m, data2h, data4h] = await Promise.all([
              fetch(`/api/trading/candles/${symbol}?interval=5m&limit=50`).then(r => r.json()),
              fetch(`/api/trading/candles/${symbol}?interval=2h&limit=50`).then(r => r.json()),
              fetch(`/api/trading/candles/${symbol}?interval=4h&limit=50`).then(r => r.json())
            ])

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
      enabled: !!botStatus?.scannedSymbols
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
    }
  }, [marketData])

    // Limpeza periódica de cache
  useEffect(() => {
    const cleanup = setInterval(cleanupCaches, 60000) // A cada minuto
    return () => clearInterval(cleanup)
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
            <div className="text-4xl mb-4">📊</div>
            <div className="text-lg font-medium mb-2">Carregando sinais...</div>
            <div className="text-sm">Aguarde enquanto os dados dos símbolos são processados</div>
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