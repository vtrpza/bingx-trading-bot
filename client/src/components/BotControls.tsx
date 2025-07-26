import { useState } from 'react'
import type { BotStatus, BotConfig } from '../types'

interface BotControlsProps {
  botStatus?: BotStatus
  onStart: () => void
  onStop: () => void
  onUpdateConfig: (config: Partial<BotConfig>) => void
  isStarting: boolean
  isStopping: boolean
  isUpdatingConfig: boolean
}

export default function BotControls({
  botStatus,
  onStart,
  onStop,
  onUpdateConfig,
  isStarting,
  isStopping,
  isUpdatingConfig
}: BotControlsProps) {
  const [showConfig, setShowConfig] = useState(false)
  const [config, setConfig] = useState({
    maxConcurrentTrades: botStatus?.config?.maxConcurrentTrades || 3,
    defaultPositionSize: botStatus?.config?.defaultPositionSize || 100,
    stopLossPercent: botStatus?.config?.stopLossPercent || 2,
    takeProfitPercent: botStatus?.config?.takeProfitPercent || 3,
    trailingStopPercent: botStatus?.config?.trailingStopPercent || 1,
    minVolumeUSDT: botStatus?.config?.minVolumeUSDT || 1000000
  })

  const handleConfigSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onUpdateConfig(config)
    setShowConfig(false)
  }

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2">
            <div className={`w-4 h-4 rounded-full ${
              botStatus?.isRunning ? 'bg-green-500' : 'bg-red-500'
            }`} />
            <span className="font-medium">
              Bot Status: {botStatus?.isRunning ? 'Running' : 'Stopped'}
            </span>
          </div>
          
          {botStatus?.isRunning && (
            <div className="text-sm text-gray-600">
              Scanning {botStatus.symbolsCount} symbols
            </div>
          )}
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowConfig(!showConfig)}
            className="btn btn-secondary"
          >
            Settings
          </button>
          
          {botStatus?.isRunning ? (
            <button
              onClick={onStop}
              disabled={isStopping}
              className="btn btn-danger"
            >
              {isStopping ? 'Stopping...' : 'Stop Bot'}
            </button>
          ) : (
            <button
              onClick={onStart}
              disabled={isStarting}
              className="btn btn-success"
            >
              {isStarting ? 'Starting...' : 'Start Bot'}
            </button>
          )}
        </div>
      </div>

      {/* Configuration Panel */}
      {showConfig && (
        <div className="mt-6 pt-6 border-t border-gray-200">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Bot Configuration</h3>
          
          <form onSubmit={handleConfigSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="label">Max Concurrent Trades</label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={config.maxConcurrentTrades}
                  onChange={(e) => setConfig({
                    ...config,
                    maxConcurrentTrades: parseInt(e.target.value)
                  })}
                  className="input"
                />
              </div>
              
              <div>
                <label className="label">Default Position Size ({botStatus?.demoMode ? 'VST' : 'USDT'})</label>
                <input
                  type="number"
                  min="10"
                  step="10"
                  value={config.defaultPositionSize}
                  onChange={(e) => setConfig({
                    ...config,
                    defaultPositionSize: parseFloat(e.target.value)
                  })}
                  className="input"
                />
              </div>
              
              <div>
                <label className="label">Stop Loss (%)</label>
                <input
                  type="number"
                  min="0.5"
                  max="10"
                  step="0.1"
                  value={config.stopLossPercent}
                  onChange={(e) => setConfig({
                    ...config,
                    stopLossPercent: parseFloat(e.target.value)
                  })}
                  className="input"
                />
              </div>
              
              <div>
                <label className="label">Take Profit (%)</label>
                <input
                  type="number"
                  min="0.5"
                  max="20"
                  step="0.1"
                  value={config.takeProfitPercent}
                  onChange={(e) => setConfig({
                    ...config,
                    takeProfitPercent: parseFloat(e.target.value)
                  })}
                  className="input"
                />
              </div>
              
              <div>
                <label className="label">Trailing Stop (%)</label>
                <input
                  type="number"
                  min="0.1"
                  max="5"
                  step="0.1"
                  value={config.trailingStopPercent}
                  onChange={(e) => setConfig({
                    ...config,
                    trailingStopPercent: parseFloat(e.target.value)
                  })}
                  className="input"
                />
              </div>
              
              <div>
                <label className="label">Min Volume (USDT)</label>
                <input
                  type="number"
                  min="100000"
                  step="100000"
                  value={config.minVolumeUSDT}
                  onChange={(e) => setConfig({
                    ...config,
                    minVolumeUSDT: parseFloat(e.target.value)
                  })}
                  className="input"
                />
              </div>
            </div>
            
            <div className="flex justify-end space-x-3">
              <button
                type="button"
                onClick={() => setShowConfig(false)}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isUpdatingConfig}
                className="btn btn-primary"
              >
                {isUpdatingConfig ? 'Updating...' : 'Update Configuration'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}