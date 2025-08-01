export const translations = {
  // Navegação
  nav: {
    dashboard: 'Painel',
    trading: 'Trading',
    assets: 'Ativos',
    settings: 'Configurações'
  },
  
  // Dashboard
  dashboard: {
    title: 'Painel de Controle',
    welcome: 'Bem-vindo ao Bot de Trading BingX',
    overview: 'Visão Geral',
    demoMode: 'Modo Demo',
    realMode: 'Modo Real',
    activeTrades: 'Trades Ativos',
    totalProfit: 'Lucro Total',
    winRate: 'Taxa de Acerto',
    totalTrades: 'Total de Trades',
    noData: 'Sem dados disponíveis'
  },
  
  // Trading
  trading: {
    title: 'Trading',
    botStatus: 'Status do Bot',
    running: 'Em Execução',
    stopped: 'Parado',
    start: 'Iniciar',
    stop: 'Parar',
    starting: 'Iniciando...',
    stopping: 'Parando...',
    configure: 'Configurar Bot',
    hideConfig: 'Ocultar Configuração',
    scanningSymbols: 'Escaneando {count} símbolos',
    
    // Abas
    tabs: {
      overview: 'Visão Geral',
      positions: 'Posições',
      history: 'Histórico',
      signals: 'Sinais',
      logs: 'Logs'
    },
    
    // Configuração do Bot
    config: {
      title: 'Configuração do Bot',
      quickSetup: 'Configuração Rápida:',
      basicSettings: 'Configurações Básicas',
      signalParameters: 'Parâmetros de Sinal',
      
      // Perfis
      profiles: {
        conservative: 'Conservador',
        conservativeDesc: 'Baixo risco, retornos estáveis',
        balanced: 'Equilibrado',
        balancedDesc: 'Risco e retornos moderados',
        aggressive: 'Agressivo',
        aggressiveDesc: 'Maior risco, potencialmente maiores retornos'
      },
      
      // Campos
      fields: {
        maxConcurrentTrades: 'Máx. Trades Simultâneos',
        defaultPositionSize: 'Tamanho Padrão da Posição',
        stopLoss: 'Stop Loss (%)',
        takeProfit: 'Take Profit (%)',
        trailingStop: 'Trailing Stop (%)',
        minVolume: 'Volume Mínimo (USDT)',
        rsiOversold: 'RSI Sobrevendido',
        rsiOverbought: 'RSI Sobrecomprado',
        volumeSpike: 'Pico de Volume',
        minSignalStrength: 'Força Mínima do Sinal (%)',
        ma1Period: 'Período MA1',
        ma2Period: 'Período MA2',
        confirmationRequired: 'Requer Múltiplas Confirmações'
      },
      
      // Tooltips
      tooltips: {
        maxConcurrentTrades: 'Número máximo de trades que o bot pode ter aberto ao mesmo tempo',
        defaultPositionSize: 'Valor padrão para investir em cada trade',
        stopLoss: 'Percentual de perda em que uma posição perdedora será fechada',
        takeProfit: 'Percentual de lucro em que uma posição vencedora será fechada',
        trailingStop: 'Percentual para trailing stop proteger lucros',
        minVolume: 'Volume mínimo em 24h necessário para negociar um símbolo',
        rsiOversold: 'Nível de RSI abaixo do qual um símbolo é considerado sobrevendido (sinal de compra)',
        rsiOverbought: 'Nível de RSI acima do qual um símbolo é considerado sobrecomprado (sinal de venda)',
        volumeSpike: 'Multiplicador para detectar picos anormais de volume',
        minSignalStrength: 'Percentual mínimo de força do sinal necessário para executar trades',
        ma1Period: 'Período para a média móvel rápida',
        ma2Period: 'Período para a média móvel lenta',
        confirmationRequired: 'Requer múltiplos indicadores técnicos para confirmar antes de negociar'
      },
      
      // Botões
      cancel: 'Cancelar',
      update: 'Atualizar Configuração',
      updating: 'Atualizando...',
      fixErrors: 'Corrija os erros de validação antes de enviar'
    },
    
    // Estatísticas
    stats: {
      title: 'Estatísticas de Trading',
      period24h: 'Últimas 24h',
      period7d: 'Últimos 7 dias',
      period30d: 'Últimos 30 dias',
      totalProfitLoss: 'Lucro/Prejuízo Total',
      totalTrades: 'Total de Trades',
      winningTrades: 'Trades Vencedores',
      losingTrades: 'Trades Perdedores',
      winRate: 'Taxa de Acerto',
      avgProfit: 'Lucro Médio',
      avgLoss: 'Prejuízo Médio',
      largestWin: 'Maior Ganho',
      largestLoss: 'Maior Perda'
    },
    
    // Posições
    positions: {
      title: 'Posições Abertas',
      noPositions: 'Nenhuma posição aberta',
      symbol: 'Símbolo',
      side: 'Lado',
      entryPrice: 'Preço de Entrada',
      currentPrice: 'Preço Atual',
      quantity: 'Quantidade',
      pnl: 'Lucro/Prejuízo',
      stopLoss: 'Stop Loss',
      takeProfit: 'Take Profit',
      duration: 'Duração'
    },
    
    // Histórico
    history: {
      title: 'Histórico de Trades',
      filters: 'Filtros',
      symbol: 'Símbolo',
      status: 'Status',
      startDate: 'Data Inicial',
      endDate: 'Data Final',
      apply: 'Aplicar',
      clear: 'Limpar',
      id: 'ID',
      type: 'Tipo',
      side: 'Lado',
      price: 'Preço',
      quantity: 'Quantidade',
      total: 'Total',
      pnl: 'Lucro/Prejuízo',
      date: 'Data',
      duration: 'Duração',
      noTrades: 'Nenhum trade encontrado'
    },
    
    // Sinais
    signals: {
      title: 'Análise de Sinais',
      watchedSymbols: 'Símbolos Monitorados',
      selectedSymbol: 'Símbolo Selecionado',
      currentPrice: 'Preço Atual',
      signal: 'Sinal',
      strength: 'Força',
      reason: 'Motivo',
      technicalIndicators: 'Indicadores Técnicos',
      ma1: 'MA1',
      ma2: 'MA2',
      rsi: 'RSI',
      volume24h: 'Volume 24h',
      avgVolume: 'Volume Médio',
      conditions: 'Condições',
      maCrossover: 'Cruzamento MA',
      rsiSignal: 'Sinal RSI',
      volumeConfirmation: 'Confirmação de Volume',
      trendAlignment: 'Alinhamento de Tendência',
      recentSignals: 'Sinais Recentes',
      loading: 'Carregando...',
      error: 'Erro ao carregar dados',
      noSignal: 'Nenhum sinal claro'
    },
    
    // Logs
    logs: {
      title: 'Logs do Sistema',
      filter: 'Filtrar',
      all: 'Todos',
      errors: 'Apenas Erros',
      level: 'Nível',
      message: 'Mensagem',
      timestamp: 'Hora',
      noLogs: 'Nenhum log disponível'
    },
    
    // Notifications
    notifications: {
      tradeExecuted: 'Trade executado: {side} {symbol}',
      positionClosed: 'Posição fechada: {symbol}',
      botStarted: 'Bot de trading iniciado com sucesso',
      botStopped: 'Bot de trading parado com sucesso',
      configUpdated: 'Configuração do bot atualizada'
    },
    
    // Confirmations
    confirmations: {
      startBot: 'Tem certeza que deseja iniciar o bot de trading?',
      stopBot: 'Tem certeza que deseja parar o bot de trading?'
    },
    
    // Connection Status
    connectionStatus: 'Conectado ao BingX'
  },
  
  // Assets
  assets: {
    title: 'Tabela de Ativos',
    totalBalance: 'Saldo Total',
    availableBalance: 'Saldo Disponível',
    inOrders: 'Em Ordens',
    refresh: 'Atualizar',
    refreshing: 'Atualizando...',
    search: 'Buscar ativo...',
    asset: 'Ativo',
    name: 'Nome',
    balance: 'Saldo',
    available: 'Disponível',
    inOrder: 'Em Ordem',
    value: 'Valor (USDT)',
    percentage: 'Percentual',
    noAssets: 'Nenhum ativo encontrado',
    error: 'Erro ao carregar ativos'
  },
  
  // Settings
  settings: {
    title: 'Configurações',
    account: 'Conta',
    apiConfiguration: 'Configuração da API',
    preferences: 'Preferências',
    
    // API
    api: {
      title: 'Configuração da API BingX',
      description: 'Configure suas chaves de API para conectar ao BingX',
      apiKey: 'API Key',
      apiSecret: 'API Secret',
      save: 'Salvar',
      saving: 'Salvando...',
      testConnection: 'Testar Conexão',
      testing: 'Testando...',
      connectionSuccess: 'Conexão bem-sucedida!',
      connectionError: 'Erro na conexão',
      invalidCredentials: 'Credenciais inválidas'
    },
    
    // Preferências
    preferenceSystem: {
      title: 'Preferências do Sistema',
      theme: 'Tema',
      themeLight: 'Claro',
      themeDark: 'Escuro',
      language: 'Idioma',
      notifications: 'Notificações',
      emailNotifications: 'Notificações por Email',
      soundAlerts: 'Alertas Sonoros',
      save: 'Salvar Preferências'
    }
  },
  
  // Common
  common: {
    buy: 'Compra',
    sell: 'Venda',
    hold: 'Aguardar',
    long: 'Long',
    short: 'Short',
    loading: 'Carregando...',
    error: 'Erro',
    success: 'Sucesso',
    warning: 'Aviso',
    info: 'Informação',
    confirm: 'Confirmar',
    cancel: 'Cancelar',
    save: 'Salvar',
    delete: 'Excluir',
    edit: 'Editar',
    close: 'Fechar',
    yes: 'Sim',
    no: 'Não',
    all: 'Todos',
    none: 'Nenhum',
    search: 'Buscar',
    filter: 'Filtrar',
    refresh: 'Atualizar',
    clear: 'Limpar',
    export: 'Exportar',
    import: 'Importar',
    download: 'Baixar',
    upload: 'Enviar',
    previous: 'Anterior',
    next: 'Próximo',
    first: 'Primeiro',
    last: 'Último',
    page: 'Página',
    of: 'de',
    showing: 'Mostrando',
    to: 'até',
    entries: 'registros',
    noData: 'Sem dados disponíveis',
    noResults: 'Nenhum resultado encontrado',
    actions: 'Ações',
    status: 'Status',
    date: 'Data',
    time: 'Hora',
    amount: 'Valor',
    price: 'Preço',
    total: 'Total',
    balance: 'Saldo',
    profit: 'Lucro',
    loss: 'Prejuízo',
    percentage: 'Percentual',
    volume: 'Volume',
    high: 'Máxima',
    low: 'Mínima',
    open: 'Abertura',
    closeX: 'Fechamento',
    change: 'Variação',
    market: 'Mercado',
    limit: 'Limite',
    stop: 'Stop',
    filled: 'Executado',
    partially: 'Parcial',
    cancelled: 'Cancelado',
    rejected: 'Rejeitado',
    expired: 'Expirado',
    pending: 'Pendente',
    active: 'Ativo',
    inactive: 'Inativo',
    enabled: 'Habilitado',
    disabled: 'Desabilitado',
    connected: 'Conectado',
    disconnected: 'Desconectado',
    online: 'Online',
    offline: 'Offline',
    syncing: 'Sincronizando',
    synced: 'Sincronizado',
    errorWarning: 'Erro',
    warningWarning: 'Aviso',
    infoInfo: 'Info',
    debug: 'Debug',
    trace: 'Trace'
  },
  
  // Errors
  errors: {
    generic: 'Ocorreu um erro inesperado',
    network: 'Erro de conexão',
    timeout: 'Tempo esgotado',
    notFound: 'Não encontrado',
    unauthorized: 'Não autorizado',
    forbidden: 'Acesso negado',
    validation: 'Erro de validação',
    server: 'Erro no servidor',
    unknown: 'Erro desconhecido'
  },
  
  // Crypto names mapping
  cryptoNames: {
    'BTC': 'Bitcoin',
    'ETH': 'Ethereum',
    'BNB': 'Binance Coin',
    'XRP': 'Ripple',
    'ADA': 'Cardano',
    'SOL': 'Solana',
    'DOT': 'Polkadot',
    'DOGE': 'Dogecoin',
    'AVAX': 'Avalanche',
    'SHIB': 'Shiba Inu',
    'MATIC': 'Polygon',
    'LTC': 'Litecoin',
    'UNI': 'Uniswap',
    'LINK': 'Chainlink',
    'ATOM': 'Cosmos',
    'ETC': 'Ethereum Classic',
    'XLM': 'Stellar',
    'ALGO': 'Algorand',
    'VET': 'VeChain',
    'TRX': 'TRON',
    'NEAR': 'NEAR Protocol',
    'FIL': 'Filecoin',
    'ICP': 'Internet Computer',
    'SAND': 'The Sandbox',
    'MANA': 'Decentraland',
    'AXS': 'Axie Infinity',
    'THETA': 'Theta Network',
    'EGLD': 'MultiversX',
    'XTZ': 'Tezos',
    'APE': 'ApeCoin',
    'CHZ': 'Chiliz',
    'KCS': 'KuCoin Token',
    'HNT': 'Helium',
    'FLOW': 'Flow',
    'BSV': 'Bitcoin SV',
    'ZEC': 'Zcash',
    'MKR': 'Maker',
    'ENJ': 'Enjin Coin',
    'BAT': 'Basic Attention Token',
    'AR': 'Arweave',
    'DASH': 'Dash',
    'WAVES': 'Waves',
    'KSM': 'Kusama',
    'COMP': 'Compound',
    'SNX': 'Synthetix',
    'OMG': 'OMG Network',
    'YFI': 'yearn.finance',
    'ZIL': 'Zilliqa',
    'QTUM': 'Qtum',
    'ICX': 'ICON',
    'CELO': 'Celo',
    'SUSHI': 'SushiSwap',
    'BAND': 'Band Protocol',
    'KAVA': 'Kava',
    'ZRX': '0x Protocol',
    'ONE': 'Harmony',
    'RSR': 'Reserve Rights',
    'ALPHA': 'Alpha Venture DAO',
    'ANKR': 'Ankr',
    'BNT': 'Bancor',
    'BAL': 'Balancer',
    'CRV': 'Curve DAO Token',
    'OCEAN': 'Ocean Protocol',
    'GRT': 'The Graph',
    'STORJ': 'Storj',
    'REN': 'Ren',
    'SKL': 'SKALE Network',
    'PERP': 'Perpetual Protocol',
    '1INCH': '1inch Network',
    'AUDIO': 'Audius',
    'FTM': 'Fantom',
    'ALICE': 'My Neighbor Alice',
    'REEF': 'Reef',
    'RUNE': 'THORChain',
    'LUNA': 'Terra Classic',
    'AAVE': 'Aave',
    'CAKE': 'PancakeSwap',
    'FTT': 'FTX Token',
    'SRM': 'Serum',
    'USDT': 'Tether',
    'USDC': 'USD Coin',
    'BUSD': 'Binance USD',
    'DAI': 'Dai',
    'TUSD': 'TrueUSD',
    'USDP': 'Pax Dollar',
    'UST': 'TerraUSD',
    'VST': 'Virtual Stable Token (Demo)'
  }
}