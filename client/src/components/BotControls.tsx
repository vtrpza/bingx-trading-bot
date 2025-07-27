import { useState } from 'react'
import type { BotStatus, BotConfig } from '../types'

// Utility function for safe number parsing
const safeParseNumber = (value: string, fallback: number): number => {
  if (value === '' || value === undefined || value === null) {
    return fallback;
  }
  const parsed = parseFloat(value);
  return isNaN(parsed) ? fallback : parsed;
}

// Predefined trading profiles
const TRADING_PROFILES = {
  conservative: {
    name: 'Conservative',
    description: 'Low risk, stable returns',
    config: {
      maxConcurrentTrades: 2,
      defaultPositionSize: 50,
      stopLossPercent: 1.5,
      takeProfitPercent: 2.5,
      trailingStopPercent: 0.8,
      minVolumeUSDT: 2000000,
      rsiOversold: 25,
      rsiOverbought: 75,
      volumeSpikeThreshold: 2.0,
      minSignalStrength: 75,
      confirmationRequired: true,
      ma1Period: 9,
      ma2Period: 21
    }
  },
  balanced: {
    name: 'Balanced',
    description: 'Moderate risk and returns',
    config: {
      maxConcurrentTrades: 3,
      defaultPositionSize: 100,
      stopLossPercent: 2,
      takeProfitPercent: 3,
      trailingStopPercent: 1,
      minVolumeUSDT: 1000000,
      rsiOversold: 30,
      rsiOverbought: 70,
      volumeSpikeThreshold: 1.5,
      minSignalStrength: 65,
      confirmationRequired: true,
      ma1Period: 9,
      ma2Period: 21
    }
  },
  aggressive: {
    name: 'Aggressive',
    description: 'Higher risk, potentially higher returns',
    config: {
      maxConcurrentTrades: 5,
      defaultPositionSize: 200,
      stopLossPercent: 3,
      takeProfitPercent: 5,
      trailingStopPercent: 1.5,
      minVolumeUSDT: 500000,
      rsiOversold: 35,
      rsiOverbought: 65,
      volumeSpikeThreshold: 1.2,
      minSignalStrength: 55,
      confirmationRequired: false,
      ma1Period: 7,
      ma2Period: 14
    }
  }
}

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
  const [activeTab, setActiveTab] = useState('basic')
  const [config, setConfig] = useState({
    maxConcurrentTrades: botStatus?.config?.maxConcurrentTrades || 3,
    defaultPositionSize: botStatus?.config?.defaultPositionSize || 100,
    stopLossPercent: botStatus?.config?.stopLossPercent || 2,
    takeProfitPercent: botStatus?.config?.takeProfitPercent || 3,
    trailingStopPercent: botStatus?.config?.trailingStopPercent || 1,
    minVolumeUSDT: botStatus?.config?.minVolumeUSDT || 1000000,
    rsiOversold: botStatus?.config?.rsiOversold || 30,
    rsiOverbought: botStatus?.config?.rsiOverbought || 70,
    volumeSpikeThreshold: botStatus?.config?.volumeSpikeThreshold || 1.5,
    minSignalStrength: botStatus?.config?.minSignalStrength || 65,
    confirmationRequired: botStatus?.config?.confirmationRequired ?? true,
    ma1Period: botStatus?.config?.ma1Period || 9,
    ma2Period: botStatus?.config?.ma2Period || 21
  })

  const handleConfigSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onUpdateConfig(config)
    setShowConfig(false)
  }

  const applyProfile = (profileKey: keyof typeof TRADING_PROFILES) => {
    const profile = TRADING_PROFILES[profileKey]
    setConfig({ ...config, ...profile.config })
  }

  const renderTabContent = () => {
    switch (activeTab) {
      case 'basic':
        return (
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
                  maxConcurrentTrades: safeParseNumber(e.target.value, config.maxConcurrentTrades)
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
                  defaultPositionSize: safeParseNumber(e.target.value, config.defaultPositionSize)
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
                  stopLossPercent: safeParseNumber(e.target.value, config.stopLossPercent)
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
                  takeProfitPercent: safeParseNumber(e.target.value, config.takeProfitPercent)
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
                  trailingStopPercent: safeParseNumber(e.target.value, config.trailingStopPercent)
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
                  minVolumeUSDT: safeParseNumber(e.target.value, config.minVolumeUSDT)
                })}
                className="input"
              />
            </div>
          </div>
        )
      
      case 'signals':
        return (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">RSI Oversold Level</label>
              <input
                type="number"
                min="10"
                max="40"
                step="1"
                value={config.rsiOversold}
                onChange={(e) => setConfig({
                  ...config,
                  rsiOversold: safeParseNumber(e.target.value, config.rsiOversold)
                })}
                className="input"
              />
            </div>
            
            <div>
              <label className="label">RSI Overbought Level</label>
              <input
                type="number"
                min="60"
                max="90"
                step="1"
                value={config.rsiOverbought}
                onChange={(e) => setConfig({
                  ...config,
                  rsiOverbought: safeParseNumber(e.target.value, config.rsiOverbought)
                })}
                className="input"
              />
            </div>
            
            <div>
              <label className="label">Volume Spike Threshold</label>
              <input
                type="number"
                min="1"
                max="5"
                step="0.1"
                value={config.volumeSpikeThreshold}
                onChange={(e) => setConfig({
                  ...config,
                  volumeSpikeThreshold: safeParseNumber(e.target.value, config.volumeSpikeThreshold)
                })}
                className="input"
              />
            </div>
            
            <div>
              <label className="label">Min Signal Strength (%)</label>
              <input
                type="number"
                min="30"
                max="90"
                step="5"
                value={config.minSignalStrength}
                onChange={(e) => setConfig({
                  ...config,
                  minSignalStrength: safeParseNumber(e.target.value, config.minSignalStrength)
                })}
                className="input"
              />
            </div>
            
            <div>
              <label className="label">MA1 Period</label>
              <input
                type="number"
                min="5"
                max="20"
                step="1"
                value={config.ma1Period}
                onChange={(e) => setConfig({
                  ...config,
                  ma1Period: safeParseNumber(e.target.value, config.ma1Period)
                })}
                className="input"
              />
            </div>
            
            <div>
              <label className="label">MA2 Period</label>
              <input
                type="number"
                min="10"
                max="50"
                step="1"
                value={config.ma2Period}
                onChange={(e) => setConfig({
                  ...config,
                  ma2Period: safeParseNumber(e.target.value, config.ma2Period)
                })}
                className="input"
              />
            </div>
            
            <div className="md:col-span-2">
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={config.confirmationRequired}
                  onChange={(e) => setConfig({
                    ...config,
                    confirmationRequired: e.target.checked
                  })}
                  className="rounded border-gray-300 text-primary-600 focus:border-primary-300 focus:ring focus:ring-primary-200 focus:ring-opacity-50"
                />
                <span className="text-sm font-medium text-gray-700">Require Multiple Confirmations</span>
              </label>
              <p className="text-xs text-gray-500 mt-1">
                When enabled, signals need multiple technical indicator confirmations to trigger trades
              </p>
            </div>
          </div>
        )
      
      default:
        return null
    }
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
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-medium text-gray-900">Bot Configuration</h3>
            
            {/* Profile Selector */}
            <div className="flex items-center space-x-2">
              <span className="text-sm text-gray-600">Quick Setup:</span>
              {Object.entries(TRADING_PROFILES).map(([key, profile]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => applyProfile(key as keyof typeof TRADING_PROFILES)}
                  className={`px-3 py-1 text-xs rounded-full border ${
                    key === 'aggressive' 
                      ? 'bg-red-100 border-red-300 text-red-700 hover:bg-red-200'
                      : key === 'conservative'
                      ? 'bg-green-100 border-green-300 text-green-700 hover:bg-green-200'
                      : 'bg-blue-100 border-blue-300 text-blue-700 hover:bg-blue-200'
                  }`}
                  title={profile.description}
                >
                  {profile.name}
                </button>
              ))}
            </div>
          </div>
          
          {/* Tab Navigation */}
          <div className="border-b border-gray-200 mb-6">
            <nav className="-mb-px flex space-x-8">
              <button
                type="button"
                onClick={() => setActiveTab('basic')}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'basic'
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Basic Settings
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('signals')}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'signals'
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Signal Parameters
              </button>
            </nav>
          </div>
          
          <form onSubmit={handleConfigSubmit} className="space-y-6">
            {/* Tab Content */}
            {renderTabContent()}
            
            <div className="flex justify-end space-x-3 pt-6 border-t border-gray-200">
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