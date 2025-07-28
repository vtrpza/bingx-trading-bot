import { useEffect, useState, useRef } from 'react'
import { useQuery } from 'react-query'
import { useWebSocket } from '../hooks/useWebSocket'

interface ActivityEvent {
  id: string
  type: 'signal_generated' | 'signal_queued' | 'trade_executed' | 'position_opened' | 'position_closed' | 'error' | 'warning' | 'info'
  level: 'info' | 'success' | 'warning' | 'error'
  symbol?: string
  message: string
  metadata?: Record<string, any>
  timestamp: number
}

const eventTypeConfig = {
  signal_generated: {
    icon: '📊',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
    textColor: 'text-blue-800',
    label: 'Sinal Gerado'
  },
  signal_queued: {
    icon: '📋',
    bgColor: 'bg-yellow-50',
    borderColor: 'border-yellow-200',
    textColor: 'text-yellow-800',
    label: 'Na Fila'
  },
  trade_executed: {
    icon: '⚡',
    bgColor: 'bg-green-50',
    borderColor: 'border-green-200',
    textColor: 'text-green-800',
    label: 'Trade Executado'
  },
  position_opened: {
    icon: '📈',
    bgColor: 'bg-indigo-50',
    borderColor: 'border-indigo-200',
    textColor: 'text-indigo-800',
    label: 'Posição Aberta'
  },
  position_closed: {
    icon: '📉',
    bgColor: 'bg-purple-50',
    borderColor: 'border-purple-200',
    textColor: 'text-purple-800',
    label: 'Posição Fechada'
  },
  error: {
    icon: '❌',
    bgColor: 'bg-red-50',
    borderColor: 'border-red-200',
    textColor: 'text-red-800',
    label: 'Erro'
  },
  warning: {
    icon: '⚠️',
    bgColor: 'bg-orange-50',
    borderColor: 'border-orange-200',
    textColor: 'text-orange-800',
    label: 'Aviso'
  },
  info: {
    icon: 'ℹ️',
    bgColor: 'bg-gray-50',
    borderColor: 'border-gray-200',
    textColor: 'text-gray-800',
    label: 'Info'
  }
}

interface FilterOptions {
  showSignals: boolean
  showTrades: boolean
  showPositions: boolean
  showErrors: boolean
  showInfo: boolean
}

export default function FeedTradingAoVivo() {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [filters, setFilters] = useState<FilterOptions>({
    showSignals: true,
    showTrades: true,
    showPositions: true,
    showErrors: true,
    showInfo: false
  })
  const feedRef = useRef<HTMLDivElement>(null)
  const { lastMessage } = useWebSocket('/ws')

  // Buscar eventos recentes da API
  useQuery(
    'recent-activity',
    async () => {
      const response = await fetch('/api/trading/parallel-bot/activity?limit=50')
      const data = await response.json()
      return data.data || []
    },
    {
      refetchInterval: 30000, // Atualizar a cada 30 segundos
      onSuccess: (data) => {
        // Adicionar eventos históricos se não existirem
        const existingIds = new Set(events.map(e => e.id))
        const newEvents = data
          .filter((e: any) => !existingIds.has(e.id))
          .map((e: any) => ({
            id: e.id || `${e.type}-${e.timestamp}`,
            type: e.type,
            level: e.level || 'info',
            symbol: e.symbol,
            message: e.message,
            metadata: e.metadata,
            timestamp: e.timestamp
          }))
        
        if (newEvents.length > 0) {
          setEvents(prev => [...newEvents, ...prev].slice(0, 100)) // Manter apenas 100 eventos
        }
      }
    }
  )

  // Processar mensagens WebSocket
  useEffect(() => {
    if (lastMessage) {
      try {
        const data = JSON.parse(lastMessage.data)
        
        // Mapear tipo de mensagem para evento de atividade
        let eventType: ActivityEvent['type'] = 'info'
        let level: ActivityEvent['level'] = 'info'
        let message = ''
        
        switch (data.type) {
          case 'signal':
            eventType = 'signal_generated'
            level = 'info'
            message = `Sinal ${data.data.action} gerado para ${data.data.symbol} (Força: ${data.data.strength}%)`
            break
          case 'signal_queued':
            eventType = 'signal_queued'
            level = 'info'
            message = `Sinal para ${data.data.symbol} adicionado à fila (Posição: #${data.data.queuePosition})`
            break
          case 'tradeExecuted':
            eventType = 'trade_executed'
            level = 'success'
            message = `Trade ${data.data.side} executado para ${data.data.symbol}`
            break
          case 'positionOpened':
            eventType = 'position_opened'
            level = 'success'
            message = `Posição ${data.data.side} aberta para ${data.data.symbol}`
            break
          case 'positionClosed':
            eventType = 'position_closed'
            level = 'info'
            message = `Posição fechada para ${data.data.symbol} (P&L: ${data.data.pnl})`
            break
          case 'error':
            eventType = 'error'
            level = 'error'
            message = data.message || 'Erro desconhecido'
            break
          case 'warning':
            eventType = 'warning'
            level = 'warning'
            message = data.message || 'Aviso'
            break
          default:
            return // Ignorar outros tipos de mensagem
        }

        const newEvent: ActivityEvent = {
          id: `ws-${Date.now()}-${Math.random()}`,
          type: eventType,
          level,
          symbol: data.data?.symbol,
          message,
          metadata: data.data,
          timestamp: Date.now()
        }

        setEvents(prev => [newEvent, ...prev].slice(0, 100))

        // Auto-scroll para o topo quando novo evento chegar
        if (feedRef.current) {
          feedRef.current.scrollTop = 0
        }
      } catch (error) {
        console.error('Erro ao processar mensagem WebSocket:', error)
      }
    }
  }, [lastMessage])

  // Filtrar eventos baseado nas opções
  const filteredEvents = events.filter(event => {
    switch (event.type) {
      case 'signal_generated':
      case 'signal_queued':
        return filters.showSignals
      case 'trade_executed':
        return filters.showTrades
      case 'position_opened':
      case 'position_closed':
        return filters.showPositions
      case 'error':
      case 'warning':
        return filters.showErrors
      case 'info':
        return filters.showInfo
      default:
        return true
    }
  })

  // Função para formatar timestamp
  const formatTime = (timestamp: number) => {
    const now = Date.now()
    const diff = now - timestamp
    
    if (diff < 60000) { // Menos de 1 minuto
      return 'Agora'
    } else if (diff < 3600000) { // Menos de 1 hora
      const minutes = Math.floor(diff / 60000)
      return `${minutes}min atrás`
    } else {
      return new Date(timestamp).toLocaleTimeString('pt-BR')
    }
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 h-full flex flex-col">
      {/* Cabeçalho com Filtros */}
      <div className="px-4 py-3 border-b border-gray-200">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold text-gray-900">Feed de Atividades</h3>
          <span className="text-sm text-gray-500">{filteredEvents.length} eventos</span>
        </div>
        
        {/* Filtros Rápidos */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setFilters(prev => ({ ...prev, showSignals: !prev.showSignals }))}
            className={`px-2 py-1 text-xs rounded-full border transition-colors ${
              filters.showSignals 
                ? 'bg-blue-100 border-blue-300 text-blue-700' 
                : 'bg-gray-100 border-gray-300 text-gray-600'
            }`}
          >
            📊 Sinais
          </button>
          <button
            onClick={() => setFilters(prev => ({ ...prev, showTrades: !prev.showTrades }))}
            className={`px-2 py-1 text-xs rounded-full border transition-colors ${
              filters.showTrades 
                ? 'bg-green-100 border-green-300 text-green-700' 
                : 'bg-gray-100 border-gray-300 text-gray-600'
            }`}
          >
            ⚡ Trades
          </button>
          <button
            onClick={() => setFilters(prev => ({ ...prev, showPositions: !prev.showPositions }))}
            className={`px-2 py-1 text-xs rounded-full border transition-colors ${
              filters.showPositions 
                ? 'bg-indigo-100 border-indigo-300 text-indigo-700' 
                : 'bg-gray-100 border-gray-300 text-gray-600'
            }`}
          >
            📈 Posições
          </button>
          <button
            onClick={() => setFilters(prev => ({ ...prev, showErrors: !prev.showErrors }))}
            className={`px-2 py-1 text-xs rounded-full border transition-colors ${
              filters.showErrors 
                ? 'bg-red-100 border-red-300 text-red-700' 
                : 'bg-gray-100 border-gray-300 text-gray-600'
            }`}
          >
            ❌ Erros
          </button>
          <button
            onClick={() => setFilters(prev => ({ ...prev, showInfo: !prev.showInfo }))}
            className={`px-2 py-1 text-xs rounded-full border transition-colors ${
              filters.showInfo 
                ? 'bg-gray-200 border-gray-400 text-gray-700' 
                : 'bg-gray-100 border-gray-300 text-gray-600'
            }`}
          >
            ℹ️ Info
          </button>
        </div>
      </div>

      {/* Feed de Eventos */}
      <div ref={feedRef} className="flex-1 overflow-y-auto p-4 space-y-2">
        {filteredEvents.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <div className="text-2xl mb-2">📭</div>
            <p>Nenhum evento para mostrar</p>
            <p className="text-sm mt-1">Os eventos aparecerão aqui em tempo real</p>
          </div>
        ) : (
          filteredEvents.map(event => {
            const config = eventTypeConfig[event.type] || eventTypeConfig.info
            const isRecent = Date.now() - event.timestamp < 30000 // 30 segundos

            return (
              <div
                key={event.id}
                className={`p-3 rounded-lg border transition-all ${
                  isRecent ? 'ring-2 ring-blue-200 animate-pulse-once' : ''
                } ${config.bgColor} ${config.borderColor}`}
              >
                <div className="flex items-start space-x-3">
                  <span className="text-xl flex-shrink-0">{config.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center space-x-2">
                        <span className={`text-xs font-medium ${config.textColor}`}>
                          {config.label}
                        </span>
                        {event.symbol && (
                          <span className="text-xs font-medium text-gray-700 bg-white px-2 py-0.5 rounded">
                            {event.symbol}
                          </span>
                        )}
                        {isRecent && (
                          <span className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full">
                            NOVO
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-gray-500">
                        {formatTime(event.timestamp)}
                      </span>
                    </div>
                    <p className="text-sm text-gray-700">
                      {event.message}
                    </p>
                    {event.metadata && Object.keys(event.metadata).length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-2">
                        {Object.entries(event.metadata)
                          .filter(([key]) => !['symbol', 'message', 'type', 'timestamp'].includes(key))
                          .slice(0, 3)
                          .map(([key, value]) => (
                            <span key={key} className="text-xs text-gray-500">
                              {key}: <span className="font-medium">{String(value)}</span>
                            </span>
                          ))
                        }
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Rodapé com Ações */}
      <div className="px-4 py-3 border-t border-gray-200 flex justify-between items-center">
        <button
          onClick={() => setEvents([])}
          className="text-sm text-red-600 hover:text-red-800"
        >
          Limpar Feed
        </button>
        <div className="flex items-center space-x-2">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
          <span className="text-sm text-gray-600">Ao vivo</span>
        </div>
      </div>
    </div>
  )
}