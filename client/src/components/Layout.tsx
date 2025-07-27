import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useQuery } from 'react-query'
import { api } from '../services/api'
import { useTranslation } from '../hooks/useTranslation'
import type { BotStatus } from '../types'

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const { t } = useTranslation()
  const location = useLocation()
  const [currentTab, setCurrentTab] = useState<'assets' | 'trading'>('assets')

  // Get bot status for the header
  const { data: botStatus } = useQuery<BotStatus>(
    'bot-status',
    () => api.getBotStatus(),
    {
      refetchInterval: 5000,
      retry: false,
    }
  )
  console.log('Bot Status:', botStatus)
  useEffect(() => {
    if (location.pathname.includes('/trading')) {
      setCurrentTab('trading')
    } else {
      setCurrentTab('assets')
    }
  }, [location.pathname])

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center">
              <h1 className="text-2xl font-bold text-gray-900">
                BingX Trading Bot
              </h1>
              {botStatus?.demoMode && (
                <span className="ml-3 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                  {t('dashboard.demoMode')}
                </span>
              )}
            </div>
            
            <div className="flex items-center space-x-4">
              {/* Bot Status Indicator */}
              <div className="flex items-center space-x-2">
                <div className={`w-3 h-3 rounded-full ${
                  botStatus?.isRunning ? 'bg-green-500' : 'bg-red-500'
                }`} />
                <span className="text-sm text-gray-600">
                  Bot {botStatus?.isRunning ? t('trading.running') : t('trading.stopped')}
                </span>
              </div>
              
              {/* Active Positions Count */}
              {botStatus && (
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-gray-600">
                    Posições: {botStatus.activePositions?.length || 0}
                  </span>
                </div>
              )}
              
              {/* Balance */}
              {botStatus?.balance && (
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-gray-600">
                    Saldo: {parseFloat(botStatus.balance.balance || '0').toFixed(2)} {botStatus.demoMode ? 'VST' : 'USDT'}
                  </span>
                </div>
              )} 
            </div>
          </div>
        </div>
      </header>

      {/* Navigation Tabs */}
      <nav className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex space-x-8">
            <Link
              to="/assets"
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                currentTab === 'assets'
                  ? 'border-primary-500 text-primary-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {t('assets.title')}
            </Link>
            <Link
              to="/trading"
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                currentTab === 'trading'
                  ? 'border-primary-500 text-primary-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {t('trading.title')}
            </Link>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  )
}