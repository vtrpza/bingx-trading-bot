import { ActivityEvent } from '../types'

interface ActivityTimelineProps {
  events: ActivityEvent[]
  mode: 'simplified' | 'professional'
  showErrors: boolean
}

export default function ActivityTimeline({ events, mode, showErrors }: ActivityTimelineProps) {
  
  const getEventIcon = (type: string) => {
    switch (type) {
      case 'scan_started':
        return '🔍'
      case 'signal_generated':
        return '📡'
      case 'trade_executed':
        return '⚡'
      case 'error':
        return '❌'
      case 'position_closed':
        return '🏁'
      case 'market_data_updated':
        return '📊'
      default:
        return '📋'
    }
  }

  const getEventColor = (level: string) => {
    switch (level) {
      case 'success':
        return 'border-green-200 bg-green-50'
      case 'error':
        return 'border-red-200 bg-red-50'
      case 'warning':
        return 'border-yellow-200 bg-yellow-50'
      case 'info':
      default:
        return 'border-blue-200 bg-blue-50'
    }
  }

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'success':
        return 'text-green-600'
      case 'error':
        return 'text-red-600'
      case 'warning':
        return 'text-yellow-600'
      case 'info':
      default:
        return 'text-blue-600'
    }
  }

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diff = now.getTime() - date.getTime()

    if (diff < 60000) { // Less than 1 minute
      return 'Just now'
    } else if (diff < 3600000) { // Less than 1 hour
      const minutes = Math.floor(diff / 60000)
      return `${minutes}m ago`
    } else if (diff < 86400000) { // Less than 1 day
      const hours = Math.floor(diff / 3600000)
      return `${hours}h ago`
    } else {
      return date.toLocaleDateString()
    }
  }

  const getEventDescription = (event: ActivityEvent, mode: 'simplified' | 'professional') => {
    if (mode === 'simplified') {
      switch (event.type) {
        case 'scan_started':
          return `Started scanning ${event.metadata?.symbolsCount || 'market'} for opportunities`
        case 'signal_generated':
          return `Found ${event.metadata?.strength || 'a'}% confidence ${event.symbol} signal`
        case 'trade_executed':
          return `${event.symbol} trade executed successfully`
        case 'error':
          return event.message
        case 'position_closed':
          return `${event.symbol} position closed`
        case 'market_data_updated':
          return `Market data refreshed for ${event.symbol || 'symbols'}`
        default:
          return event.message
      }
    } else {
      return event.message
    }
  }

  const filteredEvents = showErrors ? events : events.filter(event => event.level !== 'error')

  return (
    <div className="card p-6">
      <div className="flex justify-between items-center mb-4">
        <h4 className="text-md font-medium text-gray-900">
          Live Activity Feed ({filteredEvents.length})
        </h4>
        
        {mode === 'professional' && (
          <div className="flex items-center space-x-2 text-sm text-gray-500">
            <span>Auto-refresh every 3s</span>
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          </div>
        )}
      </div>

      {filteredEvents.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          <span className="text-2xl mb-2 block">📊</span>
          No recent activity to display
        </div>
      ) : (
        <div className="space-y-3 max-h-96 overflow-y-auto">
          {filteredEvents.map((event) => (
            <div
              key={event.id}
              className={`flex items-start space-x-3 p-3 rounded-lg border ${getEventColor(event.level)}`}
            >
              {/* Event Icon */}
              <div className="flex-shrink-0 mt-0.5">
                <span className="text-lg">{getEventIcon(event.type)}</span>
              </div>

              {/* Event Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center space-x-2 mb-1">
                  {event.symbol && (
                    <span className="text-sm font-medium text-gray-900">{event.symbol}</span>
                  )}
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    event.level === 'success' ? 'bg-green-100 text-green-700' :
                    event.level === 'error' ? 'bg-red-100 text-red-700' :
                    event.level === 'warning' ? 'bg-yellow-100 text-yellow-700' :
                    'bg-blue-100 text-blue-700'
                  }`}>
                    {event.type.replace('_', ' ')}
                  </span>
                </div>

                <p className="text-sm text-gray-700 mb-1">
                  {getEventDescription(event, mode)}
                </p>

                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">
                    {formatTime(event.timestamp)}
                  </span>
                  
                  {mode === 'professional' && (
                    <span className="text-xs text-gray-400">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </span>
                  )}
                </div>

                {/* Professional Mode Metadata */}
                {mode === 'professional' && event.metadata && Object.keys(event.metadata).length > 0 && (
                  <div className="mt-2 p-2 bg-white bg-opacity-50 rounded text-xs">
                    <details>
                      <summary className="cursor-pointer text-gray-600 hover:text-gray-800">
                        Metadata ({Object.keys(event.metadata).length} items)
                      </summary>
                      <div className="mt-1 space-y-1">
                        {Object.entries(event.metadata).map(([key, value]) => (
                          <div key={key} className="flex justify-between">
                            <span className="text-gray-500">{key}:</span>
                            <span className="text-gray-700 font-mono">
                              {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>
                )}
              </div>

              {/* Timeline connector */}
              <div className="flex-shrink-0 w-px bg-gray-200 h-full absolute left-8 mt-6" />
            </div>
          ))}
        </div>
      )}

      {/* Activity Summary */}
      <div className="mt-4 pt-4 border-t border-gray-200">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
          <div>
            <div className="text-lg font-semibold text-gray-900">
              {events.filter(e => e.type === 'signal_generated').length}
            </div>
            <div className="text-xs text-gray-500">Signals</div>
          </div>
          <div>
            <div className="text-lg font-semibold text-green-600">
              {events.filter(e => e.type === 'trade_executed').length}
            </div>
            <div className="text-xs text-gray-500">Trades</div>
          </div>
          <div>
            <div className="text-lg font-semibold text-red-600">
              {events.filter(e => e.level === 'error').length}
            </div>
            <div className="text-xs text-gray-500">Errors</div>
          </div>
          <div>
            <div className="text-lg font-semibold text-blue-600">
              {events.filter(e => e.type === 'scan_started').length}
            </div>
            <div className="text-xs text-gray-500">Scans</div>
          </div>
        </div>
      </div>
    </div>
  )
}