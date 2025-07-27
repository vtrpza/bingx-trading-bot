// WebSocket configuration with automatic protocol detection
export const getWebSocketUrl = (path: string = '/ws', fallback: boolean = false): string => {
  // In development, always use the local server
  if (process.env.NODE_ENV === 'development') {
    return `ws://localhost:3001${path}`;
  }
  
  // In production (Render), auto-detect protocol based on current page
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  
  // For Render deployment, use the same host with secure WebSocket
  return `${protocol}//${host}${path}`;
};

// Fallback WebSocket URL for cases where WSS fails
export const getFallbackWebSocketUrl = (path: string = '/ws'): string => {
  // Try the opposite protocol if the main one fails
  const protocol = window.location.protocol === 'https:' ? 'ws:' : 'wss:';
  const host = window.location.host;
  
  return `${protocol}//${host}${path}`;
};

// WebSocket configuration options
export const webSocketConfig = {
  // Reconnection settings
  reconnectInterval: 3000,
  maxReconnectAttempts: 10,
  
  // Connection timeout
  connectionTimeout: 10000,
  
  // Keep alive settings
  pingInterval: 30000,
  pongTimeout: 5000
};

// Environment-specific WebSocket debugging
export const enableWebSocketDebug = process.env.NODE_ENV === 'development';

// WebSocket status messages
export const getConnectionStatusMessage = (status: string): string => {
  switch (status) {
    case 'connecting':
      return 'Conectando ao servidor...';
    case 'connected':
      return 'Conectado';
    case 'disconnected':
      return 'Desconectado';
    case 'error':
      return 'Erro de conexão';
    default:
      return 'Status desconhecido';
  }
};