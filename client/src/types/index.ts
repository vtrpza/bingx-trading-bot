export interface Asset {
  id: number;
  symbol: string;
  name: string;
  baseCurrency: string;
  quoteCurrency: string;
  status: string;
  minQty: number;
  maxQty: number;
  tickSize: number;
  stepSize: number;
  maxLeverage: number;
  maintMarginRate: number;
  volume24h: number;
  quoteVolume24h: number;
  openInterest: number;
  lastPrice: number;
  priceChangePercent: number;
  highPrice24h: number;
  lowPrice24h: number;
  updatedAt: string;
  createdAt: string;
}

export interface Trade {
  id: number;
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  type: 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'REJECTED';
  quantity: number;
  price: number;
  executedQty: number;
  avgPrice: number;
  stopPrice?: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  commission: number;
  commissionAsset: string;
  realizedPnl: number;
  signalStrength: number;
  signalReason: string;
  indicators: any;
  executedAt?: string;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Position {
  symbol: string;
  side: 'LONG' | 'SHORT';
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unrealizedProfit: string;
  percentage: string;
  marginType: string;
  isolatedMargin: string;
  isAutoAddMargin: boolean;
  positionSide: string;
  notional: string;
  isolatedWallet: string;
  updateTime: number;
}

export interface TradingSignal {
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  strength: number;
  reason: string;
  indicators: {
    price: number;
    ma1: number;
    ma2: number;
    rsi: number;
    volume: number;
    avgVolume: number;
  };
  conditions: {
    maCrossover: boolean;
    rsiSignal: boolean;
    volumeConfirmation: boolean;
    trendAlignment: boolean;
  };
  timestamp: string;
}

export interface BotStatus {
  isRunning: boolean;
  activePositions: Position[];
  config: BotConfig;
  symbolsCount: number;
  scannedSymbols: string[];
  balance?: any;
  demoMode: boolean;
}

export interface BotConfig {
  enabled: boolean;
  maxConcurrentTrades: number;
  defaultPositionSize: number;
  scanInterval: number;
  symbolsToScan: string[];
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopPercent: number;
  minVolumeUSDT: number;
  // Signal generation parameters
  rsiOversold: number;
  rsiOverbought: number;
  volumeSpikeThreshold: number;
  minSignalStrength: number;
  confirmationRequired: boolean;
  ma1Period: number;
  ma2Period: number;
}

export interface MarketData {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  volume: number;
  quoteVolume: number;
  highPrice: number;
  lowPrice: number;
  openPrice: number;
  closeTime: number;
  count: number;
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
}

export interface TechnicalIndicators {
  price: number;
  ma1: number;
  ma2: number;
  rsi: number;
  volume: number;
  avgVolume: number;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data: T;
  error?: {
    message: string;
    stack?: string;
  };
}

export interface PaginatedResponse<T = any> {
  assets?: T[];
  trades?: T[];
  data?: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface WebSocketMessage {
  type: string;
  data: any;
}

// Trading Flow & Process Monitoring Types
export interface ProcessStep {
  id: string;
  name: string;
  status: 'idle' | 'processing' | 'completed' | 'error' | 'warning';
  startTime?: number;
  endTime?: number;
  duration?: number;
  metadata?: any;
  error?: string;
}

export interface TradingFlowState {
  currentStep: string;
  steps: ProcessStep[];
  activeSignals: SignalInProcess[];
  executionQueue: TradeInQueue[];
  metrics: ProcessMetrics;
  lastUpdate: number;
}

export interface SignalInProcess {
  id: string;
  symbol: string;
  stage: 'analyzing' | 'evaluating' | 'decided' | 'queued' | 'executing' | 'completed' | 'rejected';
  signal?: TradingSignal;
  startTime: number;
  decision?: 'execute' | 'reject';
  rejectionReason?: string;
  executionTime?: number;
}

export interface TradeInQueue {
  id: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  quantity: number;
  estimatedPrice: number;
  priority: number;
  queueTime: number;
  status: 'queued' | 'processing' | 'executed' | 'failed';
  signalId?: string;
}

export interface ProcessMetrics {
  scanningRate: number; // symbols per minute
  signalGenerationRate: number; // signals per hour
  executionSuccessRate: number; // percentage
  averageProcessingTime: {
    scanning: number;
    analysis: number;
    decision: number;
    execution: number;
  };
  performance: {
    totalScanned: number;
    signalsGenerated: number;
    tradesExecuted: number;
    errors: number;
  };
  bottlenecks: string[];
}

export interface ActivityEvent {
  id: string;
  type: 'scan_started' | 'signal_generated' | 'trade_executed' | 'error' | 'position_closed' | 'market_data_updated';
  symbol?: string;
  message: string;
  timestamp: number;
  level: 'info' | 'warning' | 'error' | 'success';
  metadata?: any;
}

export interface FlowMonitorConfig {
  mode: 'professional' | 'simplified';
  autoRefresh: boolean;
  refreshInterval: number;
  showMetrics: boolean;
  showErrors: boolean;
  maxActivityEvents: number;
}