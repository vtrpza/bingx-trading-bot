import { useState } from 'react'
import { useTranslation } from '../hooks/useTranslation'
import type { BotStatus, BotConfig } from '../types'

// Utility function for safe number parsing
const safeParseNumber = (value: string, fallback: number): number => {
  if (value === '' || value === undefined || value === null) {
    return fallback;
  }
  const parsed = parseFloat(value);
  return isNaN(parsed) ? fallback : parsed;
}

// Validation rules for each field
const VALIDATION_RULES = {
  maxConcurrentTrades: { min: 1, max: 10, step: 1 },
  defaultPositionSize: { min: 10, max: 10000, step: 10 },
  stopLossPercent: { min: 0.5, max: 10, step: 0.1 },
  takeProfitPercent: { min: 0.5, max: 20, step: 0.1 },
  trailingStopPercent: { min: 0.1, max: 5, step: 0.1 },
  minVolumeUSDT: { min: 100000, max: 10000000, step: 100000 },
  rsiOversold: { min: 10, max: 40, step: 1 },
  rsiOverbought: { min: 60, max: 90, step: 1 },
  volumeSpikeThreshold: { min: 1, max: 5, step: 0.1 },
  minSignalStrength: { min: 30, max: 90, step: 5 },
  ma1Period: { min: 5, max: 20, step: 1 },
  ma2Period: { min: 10, max: 50, step: 1 }
}

// Tooltips for each field
const TOOLTIPS = {
  maxConcurrentTrades: 'Maximum number of trades the bot can have open at the same time',
  defaultPositionSize: 'Default amount to invest in each trade',
  stopLossPercent: 'Percentage loss at which to close a losing position',
  takeProfitPercent: 'Percentage profit at which to close a winning position',
  trailingStopPercent: 'Percentage for trailing stop to protect profits',
  minVolumeUSDT: 'Minimum 24h volume required to trade a symbol',
  rsiOversold: 'RSI level below which a symbol is considered oversold (buy signal)',
  rsiOverbought: 'RSI level above which a symbol is considered overbought (sell signal)',
  volumeSpikeThreshold: 'Multiplier for detecting abnormal volume spikes',
  minSignalStrength: 'Minimum signal strength percentage required to execute trades',
  ma1Period: 'Period for the fast moving average',
  ma2Period: 'Period for the slow moving average',
  confirmationRequired: 'Require multiple technical indicators to confirm before trading'
}

// Validation function
const validateField = (field: string, value: number, config?: any): { isValid: boolean; error?: string } => {
  const rules = VALIDATION_RULES[field as keyof typeof VALIDATION_RULES]
  if (!rules) return { isValid: true }
  
  if (value < rules.min) {
    return { isValid: false, error: `Minimum value is ${rules.min}` }
  }
  if (value > rules.max) {
    return { isValid: false, error: `Maximum value is ${rules.max}` }
  }
  
  // Special validation for MA periods
  if (field === 'ma2Period' && config && value <= config.ma1Period) {
    return { isValid: false, error: 'MA2 period must be greater than MA1 period' }
  }
  if (field === 'ma1Period' && config && value >= config.ma2Period) {
    return { isValid: false, error: 'MA1 period must be less than MA2 period' }
  }
  
  return { isValid: true }
}

// Predefined trading profiles
const getTradingProfiles = (t: any) => ({
  conservative: {
    name: t('trading.config.profiles.conservative'),
    description: t('trading.config.profiles.conservativeDesc'),
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
    name: t('trading.config.profiles.balanced'),
    description: t('trading.config.profiles.balancedDesc'),
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
    name: t('trading.config.profiles.aggressive'),
    description: t('trading.config.profiles.aggressiveDesc'),
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
})

interface BotControlsProps {
  botStatus?: BotStatus
  onStart: () => void
  onStop: () => void
  onUpdateConfig: (config: Partial<BotConfig>) => void
  isStarting: boolean
  isStopping: boolean
  isUpdatingConfig: boolean
}

// Input field component with tooltip and validation
const InputField = ({ 
  label, 
  field, 
  value, 
  onChange, 
  error, 
  currency 
}: {
  label: string
  field: string
  value: number
  onChange: (value: number) => void
  error?: string
  currency?: string
}) => {
  const { t } = useTranslation()
  const rules = VALIDATION_RULES[field as keyof typeof VALIDATION_RULES]
  const tooltip = t(`trading.config.tooltips.${field}`)
  
  return (
    <div>
      <label className="label flex items-center">
        <span>{label}</span>
        {tooltip && (
          <div className="group relative ml-2">
            <svg className="w-4 h-4 text-gray-400 hover:text-gray-600 cursor-help" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
            <div className="hidden group-hover:block absolute z-10 left-0 bottom-full mb-2 w-64 p-2 text-xs text-white bg-gray-800 rounded shadow-lg">
              {tooltip}
            </div>
          </div>
        )}
        {currency && <span className="ml-auto text-sm text-gray-500">({currency})</span>}
      </label>
      <input
        type="number"
        min={rules?.min}
        max={rules?.max}
        step={rules?.step}
        value={value}
        onChange={(e) => onChange(safeParseNumber(e.target.value, value))}
        className={`input ${error ? 'border-red-500' : ''}`}
      />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
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
  const { t } = useTranslation()
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
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({})
  
  // Validate field and update config
  const updateField = (field: string, value: number) => {
    const validation = validateField(field, value, config)
    
    setConfig({ ...config, [field]: value })
    
    if (validation.isValid) {
      const errors = { ...validationErrors }
      delete errors[field]
      setValidationErrors(errors)
    } else {
      setValidationErrors({ ...validationErrors, [field]: validation.error || '' })
    }
  }

  const handleConfigSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    
    // Check if there are any validation errors
    if (Object.keys(validationErrors).length > 0) {
      alert('Por favor, corrija os erros de validação antes de enviar')
      return
    }
    
    onUpdateConfig(config)
    setShowConfig(false)
  }

  const applyProfile = (profileKey: string) => {
    const profiles = getTradingProfiles(t)
    const profile = profiles[profileKey as keyof typeof profiles]
    setConfig({ ...config, ...profile.config })
    setValidationErrors({}) // Clear any validation errors when applying a profile
  }

  const renderTabContent = () => {
    switch (activeTab) {
      case 'basic':
        return (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <InputField
              label={t('trading.config.fields.maxConcurrentTrades')}
              field="maxConcurrentTrades"
              value={config.maxConcurrentTrades}
              onChange={(value) => updateField('maxConcurrentTrades', value)}
              error={validationErrors.maxConcurrentTrades}
            />
            
            <InputField
              label={t('trading.config.fields.defaultPositionSize')}
              field="defaultPositionSize"
              value={config.defaultPositionSize}
              onChange={(value) => updateField('defaultPositionSize', value)}
              error={validationErrors.defaultPositionSize}
              currency={botStatus?.demoMode ? 'VST' : 'USDT'}
            />
            
            <InputField
              label={t('trading.config.fields.stopLoss')}
              field="stopLossPercent"
              value={config.stopLossPercent}
              onChange={(value) => updateField('stopLossPercent', value)}
              error={validationErrors.stopLossPercent}
            />
            
            <InputField
              label={t('trading.config.fields.takeProfit')}
              field="takeProfitPercent"
              value={config.takeProfitPercent}
              onChange={(value) => updateField('takeProfitPercent', value)}
              error={validationErrors.takeProfitPercent}
            />
            
            <InputField
              label={t('trading.config.fields.trailingStop')}
              field="trailingStopPercent"
              value={config.trailingStopPercent}
              onChange={(value) => updateField('trailingStopPercent', value)}
              error={validationErrors.trailingStopPercent}
            />
            
            <InputField
              label={t('trading.config.fields.minVolume')}
              field="minVolumeUSDT"
              value={config.minVolumeUSDT}
              onChange={(value) => updateField('minVolumeUSDT', value)}
              error={validationErrors.minVolumeUSDT}
            />
          </div>
        )
      
      case 'signals':
        return (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <InputField
              label="RSI Oversold Level"
              field="rsiOversold"
              value={config.rsiOversold}
              onChange={(value) => updateField('rsiOversold', value)}
              error={validationErrors.rsiOversold}
            />
            
            <InputField
              label="RSI Overbought Level"
              field="rsiOverbought"
              value={config.rsiOverbought}
              onChange={(value) => updateField('rsiOverbought', value)}
              error={validationErrors.rsiOverbought}
            />
            
            <InputField
              label="Volume Spike Threshold"
              field="volumeSpikeThreshold"
              value={config.volumeSpikeThreshold}
              onChange={(value) => updateField('volumeSpikeThreshold', value)}
              error={validationErrors.volumeSpikeThreshold}
            />
            
            <InputField
              label="Min Signal Strength (%)"
              field="minSignalStrength"
              value={config.minSignalStrength}
              onChange={(value) => updateField('minSignalStrength', value)}
              error={validationErrors.minSignalStrength}
            />
            
            <InputField
              label="MA1 Period"
              field="ma1Period"
              value={config.ma1Period}
              onChange={(value) => updateField('ma1Period', value)}
              error={validationErrors.ma1Period}
            />
            
            <InputField
              label="MA2 Period"
              field="ma2Period"
              value={config.ma2Period}
              onChange={(value) => updateField('ma2Period', value)}
              error={validationErrors.ma2Period}
            />
            
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
                {TOOLTIPS.confirmationRequired && (
                  <div className="group relative ml-2">
                    <svg className="w-4 h-4 text-gray-400 hover:text-gray-600 cursor-help" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                    </svg>
                    <div className="hidden group-hover:block absolute z-10 left-0 bottom-full mb-2 w-64 p-2 text-xs text-white bg-gray-800 rounded shadow-lg">
                      {TOOLTIPS.confirmationRequired}
                    </div>
                  </div>
                )}
              </label>
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
                disabled={isUpdatingConfig || Object.keys(validationErrors).length > 0}
                className={`btn ${Object.keys(validationErrors).length > 0 ? 'btn-secondary opacity-50 cursor-not-allowed' : 'btn-primary'}`}
                title={Object.keys(validationErrors).length > 0 ? 'Please fix validation errors before submitting' : ''}
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