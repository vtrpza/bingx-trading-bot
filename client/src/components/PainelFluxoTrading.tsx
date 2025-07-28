import { useEffect, useState } from 'react'
import { useQuery } from 'react-query'
import { useWebSocket } from '../hooks/useWebSocket'

interface PipelineStatus {
  signalWorkers: {
    active: number
    total: number
    processing: number
    utilization: number
  }
  signalQueue: {
    size: number
    processing: number
    priority: {
      high: number
      medium: number
      low: number
    }
  }
  tradeExecutors: {
    active: number
    total: number
    executing: number
    utilization: number
  }
  activePositions: number
  throughput: {
    signalsPerMinute: number
    tradesPerMinute: number
    successRate: number
  }
}

interface SignalInPipeline {
  id: string
  symbol: string
  strength: number
  status: 'queued' | 'processing' | 'executing' | 'completed' | 'failed'
  queuePosition?: number
  executorId?: string
  timestamp: number
}

export default function PainelFluxoTrading() {
  const [signalsInPipeline, setSignalsInPipeline] = useState<SignalInPipeline[]>([])
  const { lastMessage } = useWebSocket('/ws')

  // Buscar status do pipeline do bot paralelo
  const { data: pipelineStatus, isLoading } = useQuery<PipelineStatus>(
    'pipeline-status',
    async () => {
      const response = await fetch('/api/trading/parallel-bot/pipeline')
      const data = await response.json()
      return data.data
    },
    {
      refetchInterval: 2000, // Atualizar a cada 2 segundos
    }
  )

  // Buscar sinais recentes em processamento
  const { data: recentSignals } = useQuery(
    'pipeline-signals',
    async () => {
      const response = await fetch('/api/trading/parallel-bot/activity?limit=20&type=signal_generated,trade_executed')
      const data = await response.json()
      return data.data
    },
    {
      refetchInterval: 3000,
    }
  )

  // Atualizar sinais no pipeline com eventos WebSocket
  useEffect(() => {
    if (lastMessage) {
      try {
        const data = JSON.parse(lastMessage.data)
        
        if (data.type === 'signal_queued') {
          setSignalsInPipeline(prev => [...prev, {
            id: data.data.id,
            symbol: data.data.symbol,
            strength: data.data.strength,
            status: 'queued',
            queuePosition: data.data.queuePosition,
            timestamp: Date.now()
          }])
        } else if (data.type === 'signal_processing') {
          setSignalsInPipeline(prev => prev.map(signal => 
            signal.id === data.data.id 
              ? { ...signal, status: 'processing', executorId: data.data.executorId }
              : signal
          ))
        } else if (data.type === 'trade_executed') {
          setSignalsInPipeline(prev => prev.map(signal => 
            signal.symbol === data.data.symbol 
              ? { ...signal, status: 'completed' }
              : signal
          ))
          // Remover sinais completados após 5 segundos
          setTimeout(() => {
            setSignalsInPipeline(prev => prev.filter(s => s.symbol !== data.data.symbol))
          }, 5000)
        }
      } catch (error) {
        console.error('Erro ao processar mensagem WebSocket:', error)
      }
    }
  }, [lastMessage])

  // Limpar sinais antigos
  useEffect(() => {
    const interval = setInterval(() => {
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
      setSignalsInPipeline(prev => prev.filter(signal => signal.timestamp > fiveMinutesAgo))
    }, 30000)
    return () => clearInterval(interval)
  }, [])

  if (isLoading) {
    return (
      <div className="animate-pulse">
        <div className="h-48 bg-gray-200 rounded-lg"></div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Visualização do Pipeline */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 h-full flex flex-col">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Pipeline de Trading em Tempo Real</h3>
        
        <div className="flex-1 flex flex-col justify-center">
          {/* Fluxo Visual */}
          <div className="flex items-stretch space-x-3">
            {/* Sinais */}
            <div className="flex-1 flex flex-col">
              <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-3 h-full flex flex-col">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-medium text-blue-900 text-sm">Geração de Sinais</h4>
                  <span className="text-xl">📊</span>
                </div>
                <div className="space-y-2 flex-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-600">Workers Ativos:</span>
                    <span className="font-semibold text-blue-700">
                      {pipelineStatus?.signalWorkers.active || 0}/{pipelineStatus?.signalWorkers.total || 5}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-600">Processando:</span>
                    <span className="font-semibold text-blue-700">
                      {pipelineStatus?.signalWorkers.processing || 0}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-600">Utilização:</span>
                    <span className="font-semibold text-blue-700">
                      {pipelineStatus?.signalWorkers.utilization || 0}%
                    </span>
                  </div>
                </div>
                <div className="mt-2">
                  <div className="w-full bg-blue-100 rounded-full h-1.5">
                    <div 
                      className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${pipelineStatus?.signalWorkers.utilization || 0}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Seta */}
            <div className="flex items-center justify-center px-2">
              <svg className="w-6 h-6 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </div>

            {/* Fila */}
            <div className="flex-1 flex flex-col">
              <div className="bg-yellow-50 border-2 border-yellow-200 rounded-lg p-3 h-full flex flex-col">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-medium text-yellow-900 text-sm">Fila de Sinais</h4>
                  <span className="text-xl">📋</span>
                </div>
                <div className="space-y-2 flex-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-600">Na Fila:</span>
                    <span className="font-semibold text-yellow-700">
                      {pipelineStatus?.signalQueue.size || 0}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-600">Processando:</span>
                    <span className="font-semibold text-yellow-700">
                      {pipelineStatus?.signalQueue.processing || 0}
                    </span>
                  </div>
                  <div className="text-xs space-y-1">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Alta:</span>
                      <span className="font-medium text-red-600">{pipelineStatus?.signalQueue.priority.high || 0}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Média:</span>
                      <span className="font-medium text-yellow-600">{pipelineStatus?.signalQueue.priority.medium || 0}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Baixa:</span>
                      <span className="font-medium text-gray-600">{pipelineStatus?.signalQueue.priority.low || 0}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Seta */}
            <div className="flex items-center justify-center px-2">
              <svg className="w-6 h-6 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </div>

            {/* Executores */}
            <div className="flex-1 flex flex-col">
              <div className="bg-green-50 border-2 border-green-200 rounded-lg p-3 h-full flex flex-col">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-medium text-green-900 text-sm">Executores</h4>
                  <span className="text-xl">⚡</span>
                </div>
                <div className="space-y-2 flex-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-600">Executores Ativos:</span>
                    <span className="font-semibold text-green-700">
                      {pipelineStatus?.tradeExecutors.active || 0}/{pipelineStatus?.tradeExecutors.total || 3}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-600">Executando:</span>
                    <span className="font-semibold text-green-700">
                      {pipelineStatus?.tradeExecutors.executing || 2}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-600">Utilização:</span>
                    <span className="font-semibold text-green-700">
                      {pipelineStatus?.tradeExecutors.utilization || 100}%
                    </span>
                  </div>
                </div>
                <div className="mt-2">
                  <div className="w-full bg-green-100 rounded-full h-1.5">
                    <div 
                      className="bg-green-500 h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${pipelineStatus?.tradeExecutors.utilization || 100}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Seta */}
            <div className="flex items-center justify-center px-2">
              <svg className="w-6 h-6 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </div>

            {/* Posições */}
            <div className="flex-1 flex flex-col">
              <div className="bg-purple-50 border-2 border-purple-200 rounded-lg p-3 h-full flex flex-col">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-medium text-purple-900 text-sm">Posições Ativas</h4>
                  <span className="text-xl">💼</span>
                </div>
                <div className="text-center flex-1 flex flex-col justify-center">
                  <div className="text-2xl font-bold text-purple-700">
                    {pipelineStatus?.activePositions || 13}
                  </div>
                  <div className="text-xs text-gray-600 mt-1">
                    Posições Abertas
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Métricas de Throughput */}
          <div className="mt-4 grid grid-cols-3 gap-3">
            <div className="bg-gray-50 rounded-lg p-2 text-center">
              <div className="text-xs text-gray-600">Sinais/min</div>
              <div className="text-xl font-bold text-gray-900">
                {pipelineStatus?.throughput.signalsPerMinute?.toFixed(1) || '0.0'}
              </div>
            </div>
            <div className="bg-gray-50 rounded-lg p-2 text-center">
              <div className="text-xs text-gray-600">Trades/min</div>
              <div className="text-xl font-bold text-gray-900">
                {pipelineStatus?.throughput.tradesPerMinute?.toFixed(1) || '0.0'}
              </div>
            </div>
            <div className="bg-gray-50 rounded-lg p-2 text-center">
              <div className="text-xs text-gray-600">Taxa de Sucesso</div>
              <div className="text-xl font-bold text-gray-900">
                {pipelineStatus?.throughput.successRate?.toFixed(1) || '0.0'}%
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Sinais em Processamento */}
      {signalsInPipeline.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <h4 className="font-medium text-gray-900 mb-3">Sinais em Processamento</h4>
          <div className="space-y-2">
            {signalsInPipeline.slice(0, 5).map(signal => (
              <div key={signal.id} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                <div className="flex items-center space-x-3">
                  <span className="font-medium text-gray-900">{signal.symbol}</span>
                  <span className="text-sm text-gray-600">Força: {signal.strength}%</span>
                </div>
                <div className="flex items-center space-x-2">
                  {signal.status === 'queued' && (
                    <>
                      <span className="text-sm text-yellow-600">Na fila</span>
                      {signal.queuePosition && (
                        <span className="text-xs text-gray-500">#{signal.queuePosition}</span>
                      )}
                    </>
                  )}
                  {signal.status === 'processing' && (
                    <>
                      <span className="text-sm text-blue-600">Processando</span>
                      {signal.executorId && (
                        <span className="text-xs text-gray-500">{signal.executorId}</span>
                      )}
                    </>
                  )}
                  {signal.status === 'executing' && (
                    <span className="text-sm text-green-600">Executando</span>
                  )}
                  {signal.status === 'completed' && (
                    <span className="text-sm text-green-700 font-medium">✓ Concluído</span>
                  )}
                  {signal.status === 'failed' && (
                    <span className="text-sm text-red-600">✗ Falhou</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}