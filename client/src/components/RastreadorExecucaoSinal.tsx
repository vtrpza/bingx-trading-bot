import { useState, useEffect } from 'react'
import { useQuery } from 'react-query'
import { useWebSocket } from '../hooks/useWebSocket'

interface SignalTracking {
  id: string
  symbol: string
  action: 'BUY' | 'SELL' | 'HOLD'
  strength: number
  status: 'analyzing' | 'queued' | 'executing' | 'completed' | 'rejected'
  stages: {
    analyzed: boolean
    queued: boolean
    executed: boolean
    positionOpened: boolean
  }
  timeline: {
    created: number
    analyzed?: number
    queued?: number
    executionStarted?: number
    executionCompleted?: number
  }
  details: {
    queuePosition?: number
    executorId?: string
    rejectionReason?: string
    positionSize?: number
    entryPrice?: number
  }
}

interface Props {
  symbolFilter?: string
  limit?: number
}

export default function RastreadorExecucaoSinal({ symbolFilter, limit = 10 }: Props) {
  const [trackedSignals, setTrackedSignals] = useState<SignalTracking[]>([])
  const { lastMessage } = useWebSocket('/ws')

  // Buscar sinais recentes para rastreamento
  // const { data: recentSignals } = useQuery(
  //   ['signal-tracking', symbolFilter],
  //   async () => {
  //     const url = symbolFilter 
  //       ? `/api/trading/parallel-bot/signal-tracking?symbol=${symbolFilter}&limit=${limit}`
  //       : `/api/trading/parallel-bot/signal-tracking?limit=${limit}`
      
  //     const response = await fetch(url)
  //     const data = await response.json()
  //     return data.data || []
  //   },
  //   {
  //     refetchInterval: 5000,
  //     onSuccess: (data) => {
  //       // Atualizar sinais rastreados com dados da API
  //       const newSignals = data.map((signal: any) => ({
  //         id: signal.id,
  //         symbol: signal.symbol,
  //         action: signal.action,
  //         strength: signal.strength,
  //         status: signal.status,
  //         stages: signal.stages || {
  //           analyzed: true,
  //           queued: signal.status !== 'analyzing',
  //           executed: ['executing', 'completed'].includes(signal.status),
  //           positionOpened: signal.status === 'completed'
  //         },
  //         timeline: signal.timeline || {
  //           created: signal.timestamp,
  //           analyzed: signal.analyzedAt,
  //           queued: signal.queuedAt,
  //           executionStarted: signal.executionStartedAt,
  //           executionCompleted: signal.executionCompletedAt
  //         },
  //         details: signal.details || {}
  //       }))

  //       setTrackedSignals(newSignals)
  //     }
  //   }
  // )

  // Processar eventos WebSocket para atualização em tempo real
  useEffect(() => {
    if (lastMessage) {
      try {
        const data = JSON.parse(lastMessage.data)
        
        switch (data.type) {
          case 'signal':
            // Novo sinal gerado
            const newSignal: SignalTracking = {
              id: `signal-${Date.now()}`,
              symbol: data.data.symbol,
              action: data.data.action,
              strength: data.data.strength,
              status: 'analyzing',
              stages: {
                analyzed: false,
                queued: false,
                executed: false,
                positionOpened: false
              },
              timeline: {
                created: Date.now()
              },
              details: {}
            }
            
            setTrackedSignals(prev => [newSignal, ...prev].slice(0, limit))
            break

          case 'signal_analyzed':
            setTrackedSignals(prev => prev.map(signal => 
              signal.symbol === data.data.symbol && signal.status === 'analyzing'
                ? {
                    ...signal,
                    status: 'queued',
                    stages: { ...signal.stages, analyzed: true },
                    timeline: { ...signal.timeline, analyzed: Date.now() }
                  }
                : signal
            ))
            break

          case 'signal_queued':
            setTrackedSignals(prev => prev.map(signal => 
              signal.symbol === data.data.symbol
                ? {
                    ...signal,
                    status: 'queued',
                    stages: { ...signal.stages, queued: true },
                    timeline: { ...signal.timeline, queued: Date.now() },
                    details: { ...signal.details, queuePosition: data.data.queuePosition }
                  }
                : signal
            ))
            break

          case 'signal_executing':
            setTrackedSignals(prev => prev.map(signal => 
              signal.symbol === data.data.symbol
                ? {
                    ...signal,
                    status: 'executing',
                    stages: { ...signal.stages, executed: true },
                    timeline: { ...signal.timeline, executionStarted: Date.now() },
                    details: { ...signal.details, executorId: data.data.executorId }
                  }
                : signal
            ))
            break

          case 'tradeExecuted':
            setTrackedSignals(prev => prev.map(signal => 
              signal.symbol === data.data.symbol && signal.status === 'executing'
                ? {
                    ...signal,
                    status: 'completed',
                    stages: { ...signal.stages, positionOpened: true },
                    timeline: { ...signal.timeline, executionCompleted: Date.now() },
                    details: { 
                      ...signal.details, 
                      positionSize: data.data.quantity,
                      entryPrice: data.data.price
                    }
                  }
                : signal
            ))
            break

          case 'signal_rejected':
            setTrackedSignals(prev => prev.map(signal => 
              signal.symbol === data.data.symbol
                ? {
                    ...signal,
                    status: 'rejected',
                    details: { ...signal.details, rejectionReason: data.data.reason }
                  }
                : signal
            ))
            break
        }
      } catch (error) {
        console.error('Erro ao processar WebSocket:', error)
      }
    }
  }, [lastMessage, limit])

  // Calcular tempo decorrido
  const getElapsedTime = (startTime: number, endTime?: number) => {
    const end = endTime || Date.now()
    const elapsed = end - startTime
    
    if (elapsed < 1000) return `${elapsed}ms`
    if (elapsed < 60000) return `${(elapsed / 1000).toFixed(1)}s`
    return `${(elapsed / 60000).toFixed(1)}min`
  }

  // Obter cor do status
  const getStatusColor = (status: SignalTracking['status']) => {
    switch (status) {
      case 'analyzing': return 'text-blue-600 bg-blue-50'
      case 'queued': return 'text-yellow-600 bg-yellow-50'
      case 'executing': return 'text-orange-600 bg-orange-50'
      case 'completed': return 'text-green-600 bg-green-50'
      case 'rejected': return 'text-red-600 bg-red-50'
      default: return 'text-gray-600 bg-gray-50'
    }
  }

  // Obter ícone do status
  const getStatusIcon = (status: SignalTracking['status']) => {
    switch (status) {
      case 'analyzing': return '🔍'
      case 'queued': return '📋'
      case 'executing': return '⚡'
      case 'completed': return '✅'
      case 'rejected': return '❌'
      default: return '❓'
    }
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-900">Rastreamento de Execução de Sinais</h3>
        {symbolFilter && (
          <span className="text-sm text-gray-500">Filtrado por: {symbolFilter}</span>
        )}
      </div>

      <div className="space-y-3">
        {trackedSignals.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <div className="text-2xl mb-2">🎯</div>
            <p>Nenhum sinal sendo rastreado</p>
            <p className="text-sm mt-1">Os sinais aparecerão aqui quando forem gerados</p>
          </div>
        ) : (
          trackedSignals.map(signal => (
            <div key={signal.id} className="border border-gray-200 rounded-lg p-4">
              {/* Cabeçalho do Sinal */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center space-x-3">
                  <span className="font-medium text-gray-900">{signal.symbol}</span>
                  <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                    signal.action === 'BUY' ? 'bg-green-100 text-green-800' :
                    signal.action === 'SELL' ? 'bg-red-100 text-red-800' :
                    'bg-gray-100 text-gray-800'
                  }`}>
                    {signal.action}
                  </span>
                  <span className="text-sm text-gray-600">
                    Força: <span className="font-medium">{signal.strength}%</span>
                  </span>
                </div>
                <div className={`flex items-center space-x-2 px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(signal.status)}`}>
                  <span>{getStatusIcon(signal.status)}</span>
                  <span>{signal.status.charAt(0).toUpperCase() + signal.status.slice(1)}</span>
                </div>
              </div>

              {/* Pipeline de Estágios */}
              <div className="flex items-center justify-between mb-3">
                {/* Análise */}
                <div className="flex flex-col items-center">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                    signal.stages.analyzed ? 'bg-green-500 text-white' : 'bg-gray-300 text-gray-600'
                  }`}>
                    1
                  </div>
                  <span className="text-xs text-gray-600 mt-1">Análise</span>
                </div>

                {/* Linha de Progresso */}
                <div className={`flex-1 h-0.5 mx-2 ${
                  signal.stages.analyzed ? 'bg-green-500' : 'bg-gray-300'
                }`} />

                {/* Fila */}
                <div className="flex flex-col items-center">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                    signal.stages.queued ? 'bg-green-500 text-white' : 'bg-gray-300 text-gray-600'
                  }`}>
                    2
                  </div>
                  <span className="text-xs text-gray-600 mt-1">Fila</span>
                </div>

                {/* Linha de Progresso */}
                <div className={`flex-1 h-0.5 mx-2 ${
                  signal.stages.queued && signal.stages.executed ? 'bg-green-500' : 'bg-gray-300'
                }`} />

                {/* Execução */}
                <div className="flex flex-col items-center">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                    signal.stages.executed ? 'bg-green-500 text-white' : 'bg-gray-300 text-gray-600'
                  }`}>
                    3
                  </div>
                  <span className="text-xs text-gray-600 mt-1">Execução</span>
                </div>

                {/* Linha de Progresso */}
                <div className={`flex-1 h-0.5 mx-2 ${
                  signal.stages.executed && signal.stages.positionOpened ? 'bg-green-500' : 'bg-gray-300'
                }`} />

                {/* Posição */}
                <div className="flex flex-col items-center">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                    signal.stages.positionOpened ? 'bg-green-500 text-white' : 
                    signal.status === 'rejected' ? 'bg-red-500 text-white' : 
                    'bg-gray-300 text-gray-600'
                  }`}>
                    {signal.status === 'rejected' ? '✗' : '4'}
                  </div>
                  <span className="text-xs text-gray-600 mt-1">Posição</span>
                </div>
              </div>

              {/* Detalhes e Timeline */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                {/* Detalhes */}
                <div className="space-y-1">
                  {signal.details.queuePosition !== undefined && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Posição na Fila:</span>
                      <span className="font-medium">#{signal.details.queuePosition}</span>
                    </div>
                  )}
                  {signal.details.executorId && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Executor:</span>
                      <span className="font-medium">{signal.details.executorId}</span>
                    </div>
                  )}
                  {signal.details.positionSize && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Tamanho:</span>
                      <span className="font-medium">{signal.details.positionSize.toFixed(6)}</span>
                    </div>
                  )}
                  {signal.details.entryPrice && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Preço Entrada:</span>
                      <span className="font-medium">${signal.details.entryPrice.toFixed(4)}</span>
                    </div>
                  )}
                  {signal.details.rejectionReason && (
                    <div className="col-span-2">
                      <span className="text-red-600">Motivo: {signal.details.rejectionReason}</span>
                    </div>
                  )}
                </div>

                {/* Timeline */}
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Tempo Total:</span>
                    <span className="font-medium">
                      {getElapsedTime(signal.timeline.created)}
                    </span>
                  </div>
                  {signal.timeline.analyzed && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Análise:</span>
                      <span className="font-medium">
                        {getElapsedTime(signal.timeline.created, signal.timeline.analyzed)}
                      </span>
                    </div>
                  )}
                  {signal.timeline.queued && signal.timeline.executionStarted && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Na Fila:</span>
                      <span className="font-medium">
                        {getElapsedTime(signal.timeline.queued, signal.timeline.executionStarted)}
                      </span>
                    </div>
                  )}
                  {signal.timeline.executionStarted && signal.timeline.executionCompleted && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Execução:</span>
                      <span className="font-medium">
                        {getElapsedTime(signal.timeline.executionStarted, signal.timeline.executionCompleted)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}