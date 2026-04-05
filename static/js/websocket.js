/**
 * SDH – WebSocket Transport Module
 * ===================================
 * Owns the WebSocket connection lifecycle for real-time chat.
 *
 * Connects to:  ws(s)://<host>/ws/chat/<user_id>/
 *
 * Responsibilities:
 *   - Open / close / reconnect the socket
 *   - Send message payloads
 *   - Parse incoming frames and dispatch to SDH.Chat
 *   - Keep-alive ping every 25 s
 *   - Exponential back-off reconnect (up to 5 attempts)
 *
 * Close codes the backend can emit:
 *   4001 – unauthenticated          → do NOT reconnect
 *   4003 – self-chat forbidden      → do NOT reconnect
 *   4004 – target user not found    → do NOT reconnect
 *
 * Public API (SDH.WS):
 *   connectWebSocket(userId)        – open socket to /ws/chat/<userId>/
   *   sendMessage(payload)             – JSON-encode and transmit
 *   receiveMessage(event)           – parse frame, dispatch to SDH.Chat
 *   isOpen()                        – true while socket is OPEN
 *   disconnect()                    – clean close (code 1000)
 */

'use strict';

window.SDH = window.SDH || {};

SDH.WS = (() => {

  // ── Private state ─────────────────────────────────────────────
  let socket           = null;
  let currentUserId    = null;
  let pingInterval     = null;
  let reconnectTimer   = null;
  let reconnectCount   = 0;

  // ── Constants ──────────────────────────────────────────────────
  const MAX_RECONNECTS  = 5;
  const PING_INTERVAL   = 25_000;   // ms – keep-alive heartbeat
  const BASE_DELAY      = 2_000;    // ms – base for exponential back-off

  // Close codes that mean "don't try again"
  const NO_RECONNECT_CODES = new Set([1000, 4001, 4003, 4004]);


  // ═══════════════════════════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════════════════════════

  /**
   * connectWebSocket(userId)
   * Opens a new WebSocket to /ws/chat/<userId>/.
   * Any existing open socket is closed cleanly first.
   *
   * @param {number|string} userId  – numeric Django User pk
   */
  function connectWebSocket(userId) {
    if (!userId) {
      console.warn('[SDH.WS] connectWebSocket called without userId.');
      return;
    }

    // ── Tear down existing connection ────────────────────────────
    if (socket) {
      socket.onclose = null;    // suppress the reconnect handler
      socket.close(1000, 'Switching conversation');
      _clearTimers();
      socket = null;
    }

    currentUserId  = userId;
    reconnectCount = 0;
    _openSocket(userId);
  }

  /**
   * sendMessage(payload)
   * JSON-serialise and send payload over the open socket.
   *
   * @param  {object}  payload – any JSON-serialisable object
   * @returns {boolean}        – true if sent, false if socket not ready
   */
  function sendMessage(payload) {
    if (!isOpen()) {
      console.warn('[SDH.WS] Cannot send – socket not open.', payload?.type);
      return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
  }

  /**
   * receiveMessage(event)
   * WebSocket onmessage handler.
   * Parses the frame and forwards to SDH.Chat._onWsMessage(data).
   *
   * @param {MessageEvent} event
   */
  function receiveMessage(event) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (err) {
      console.error('[SDH.WS] Failed to parse frame:', err, event.data);
      return;
    }
    SDH.Chat?._onWsMessage?.(data);
  }

  /**
   * isOpen()
   * @returns {boolean} true when the underlying socket is in OPEN state.
   */
  function isOpen() {
    return socket?.readyState === WebSocket.OPEN;
  }

  /**
   * disconnect()
   * Intentionally close the socket and cancel all reconnection attempts.
   */
  function disconnect() {
    currentUserId = null;
    _clearTimers();
    if (socket) {
      socket.onclose = null;
      socket.close(1000, 'User navigated away');
      socket = null;
    }
  }


  // ═══════════════════════════════════════════════════════════════
  //  Private helpers
  // ═══════════════════════════════════════════════════════════════

  function _openSocket(userId) {
    // Resolve correct ws(s):// base
    const wsBase =
      window.SDH_DATA?.wsBase ||
      (window.location.protocol === 'https:' ? 'wss://' : 'ws://') +
      window.location.host;

    const url = `${wsBase}/ws/chat/${userId}/`;
    console.log(`[SDH.WS] Connecting → ${url}`);

    socket            = new WebSocket(url);
    socket.onopen     = _onOpen;
    socket.onmessage  = receiveMessage;
    socket.onclose    = _onClose;
    socket.onerror    = _onError;
  }

  // ── Socket event handlers ─────────────────────────────────────

  function _onOpen() {
    console.log('[SDH.WS] Connection established.');
    reconnectCount = 0;
    _startPing();
    SDH.Chat?._onWsOpen?.();
  }

  function _onClose(event) {
    _clearTimers();
    console.warn(`[SDH.WS] Closed. code=${event.code}  reason="${event.reason}"`);

    if (NO_RECONNECT_CODES.has(event.code)) {
      // Deliberate or auth-rejection close – surface to chat UI and stop
      SDH.Chat?._onWsClose?.(event);
      return;
    }

    // ── Exponential back-off reconnect ────────────────────────────
    if (currentUserId && reconnectCount < MAX_RECONNECTS) {
      reconnectCount++;
      const delay = BASE_DELAY * Math.pow(2, reconnectCount - 1); // 2 / 4 / 8 / 16 / 32 s
      console.log(
        `[SDH.WS] Reconnect attempt ${reconnectCount}/${MAX_RECONNECTS} in ${delay} ms…`
      );
      SDH.Chat?._onWsReconnecting?.(reconnectCount);
      reconnectTimer = setTimeout(() => _openSocket(currentUserId), delay);
    } else {
      console.error('[SDH.WS] Max reconnect attempts reached. Giving up.');
      SDH.Chat?._onWsClose?.(event);
    }
  }

  function _onError(event) {
    // onclose fires immediately after – no separate action needed here
    console.error('[SDH.WS] Socket error:', event);
  }

  // ── Keep-alive ping ───────────────────────────────────────────

  function _startPing() {
    _clearTimers();
    pingInterval = setInterval(() => {
      if (isOpen()) {
        socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, PING_INTERVAL);
  }

  function _clearTimers() {
    if (pingInterval)   { clearInterval(pingInterval);   pingInterval   = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer);  reconnectTimer = null; }
  }

  // ── Expose public API ─────────────────────────────────────────
  return {
    connectWebSocket,
    sendMessage,
    receiveMessage,
    isOpen,
    disconnect,
  };

})();
