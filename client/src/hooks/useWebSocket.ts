import { useState, useEffect, useRef, useCallback } from 'react'

interface UseWebSocketOptions {
  onOpen?: (event: Event) => void
  onClose?: (event: CloseEvent) => void
  onError?: (event: Event) => void
  reconnectInterval?: number
  maxReconnectAttempts?: number
}

export function useWebSocket(url: string, options: UseWebSocketOptions = {}) {
  const {
    onOpen,
    onClose,
    onError,
    reconnectInterval = 3000,
    maxReconnectAttempts = 5
  } = options

  const [socket, setSocket] = useState<WebSocket | null>(null)
  const [lastMessage, setLastMessage] = useState<MessageEvent | null>(null)
  const [readyState, setReadyState] = useState<number>(WebSocket.CONNECTING)
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting')

  const reconnectAttempts = useRef(0)
  const reconnectTimeoutId = useRef<NodeJS.Timeout | null>(null)
  const shouldReconnect = useRef(true)

  const connect = useCallback(() => {
    try {
      const wsUrl = url.startsWith('ws') ? url : `ws://${window.location.host}${url}`
      const ws = new WebSocket(wsUrl)

      ws.onopen = (event) => {
        setReadyState(WebSocket.OPEN)
        setConnectionStatus('connected')
        reconnectAttempts.current = 0
        onOpen?.(event)
      }

      ws.onclose = (event) => {
        setReadyState(WebSocket.CLOSED)
        setConnectionStatus('disconnected')
        onClose?.(event)

        // Attempt to reconnect if not closed intentionally
        if (shouldReconnect.current && reconnectAttempts.current < maxReconnectAttempts) {
          reconnectAttempts.current++
          setConnectionStatus('connecting')
          reconnectTimeoutId.current = setTimeout(connect, reconnectInterval)
        }
      }

      ws.onerror = (event) => {
        setReadyState(WebSocket.CLOSED)
        setConnectionStatus('error')
        onError?.(event)
      }

      ws.onmessage = (event) => {
        setLastMessage(event)
      }

      setSocket(ws)
    } catch (error) {
      setConnectionStatus('error')
      console.error('WebSocket connection failed:', error)
    }
  }, [url, onOpen, onClose, onError, reconnectInterval, maxReconnectAttempts])

  const sendMessage = useCallback((data: string | object) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      const message = typeof data === 'string' ? data : JSON.stringify(data)
      socket.send(message)
    } else {
      console.warn('WebSocket is not connected')
    }
  }, [socket])

  const sendJsonMessage = useCallback((data: object) => {
    sendMessage(JSON.stringify(data))
  }, [sendMessage])

  const disconnect = useCallback(() => {
    shouldReconnect.current = false
    if (reconnectTimeoutId.current) {
      clearTimeout(reconnectTimeoutId.current)
    }
    if (socket) {
      socket.close()
    }
  }, [socket])

  const reconnect = useCallback(() => {
    disconnect()
    shouldReconnect.current = true
    reconnectAttempts.current = 0
    setTimeout(connect, 100)
  }, [connect, disconnect])

  useEffect(() => {
    connect()

    return () => {
      shouldReconnect.current = false
      if (reconnectTimeoutId.current) {
        clearTimeout(reconnectTimeoutId.current)
      }
      if (socket) {
        socket.close()
      }
    }
  }, [connect])

  return {
    socket,
    lastMessage,
    readyState,
    connectionStatus,
    sendMessage,
    sendJsonMessage,
    disconnect,
    reconnect
  }
}