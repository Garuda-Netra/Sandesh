  /**
   * SDH Chat Module  (production)
   * =================================
   * Features:
   *   - WebSocket connection lifecycle
   *   - Sending / receiving plain-text messages
   *   - Typing indicators with debounce
   *   - File attachment handling
   *   - Message rendering with date separators
   *   - Presence / online status + last-seen
   *   - Unread counts + sidebar badges
   *   - Browser push notifications (Notification API)
   *   - Sidebar behaviour (mobile)
   */

  'use strict';

  window.SDH = window.SDH || {};

  SDH.Chat = (() => {

    // â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let activeUser    = null;
    let activeUserId  = null;
    let typingTimer   = null;
    let isTyping      = false;
    let pendingFile   = null;
    let unreadCounts  = {};

    // Maps tempId â†’ null until server echo assigns real id
    const pendingAckMap = new Map();
    // Set of rendered message IDs (prevents duplicate renders from WS echo)
    const renderedIds   = new Set();

    // â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const MAX_FILE_SIZE  = 20 * 1024 * 1024;
    const TYPING_TIMEOUT = 2500;

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Browser Notification
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    const Notif = {
      requestPermission() {
        if (!('Notification' in window)) return;
        if (Notification.permission === 'default') Notification.requestPermission();
      },
      show(title, body, tag) {
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'granted') return;
        if (document.visibilityState === 'visible') return;
        try {
          const n = new Notification(title, { body, tag, silent: false });
          n.onclick = () => { window.focus(); n.close(); };
          setTimeout(() => n.close(), 6000);
        } catch { /* Firefox private mode */ }
      },
    };

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  WebSocket message dispatcher
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    async function _onWsMessage(data) {
      switch (data.type) {
        case 'chat_message':        await handleIncomingMessage(data);       break;
        case 'file_notification':   await handleIncomingFileNotification(data); break;
        case 'typing':              handleTypingIndicator(data);             break;
        case 'delivered':     _setMsgStatus(data.message_id, 'delivered');  break;
        case 'read_receipt':  _markAllSentAsRead();                          break;
        case 'message_status': _setMsgStatus(data.message_id, data.status); break;
        case 'presence':            handlePresence(data);                    break;
        case 'message_removed':     handleMessageRemoved(data);              break;
        case 'chat_cleared':         handleChatCleared(data);                 break;
        case 'user_removed':         handleUserRemoved(data);                 break;
        case 'pong':                                                          break;
        case 'error': console.error('[Chat] Server error:', data.message);   break;
      }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  WebSocket lifecycle callbacks
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    function _onWsOpen() {
      _setHeaderStatus('Active', 'connected');
      // Immediately notify the sender that we've read all messages in this chat
      if (activeUser && SDH.WS.isOpen()) {
        SDH.WS.sendMessage({ type: 'read_receipt' });
      }
    }

    function _onWsClose(event) {
      _setHeaderStatus('Disconnected', 'disconnected');
      if (event.code === 4001) showToast('Session expired. Please log in again.', 'error');
      else if (event.code === 4003) showToast('Cannot send messages to yourself.', 'error');
      else if (event.code === 4004) showToast('User not found.', 'error');
    }

    function _onWsReconnecting(attempt) {
      _setHeaderStatus(`Reconnecting (${attempt}/5)`, 'reconnecting');
      if (attempt === 1) showToast('Connection lost. Reconnecting', 'warning');
    }

    function _setHeaderStatus(text, state) {
      const el = document.getElementById('chatTypingStatus');
      if (!el) return;
      el.textContent = text;
      const classes = {
        connected:    'text-green-400/80',
        disconnected: 'text-red-400/70',
        reconnecting: 'text-yellow-400/70',
        typing:       'text-divine-gold/80',
        default:      'text-divine-muted',
      };
      el.className = `text-xs truncate transition-colors ${classes[state] || classes.default}`;
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Incoming message handlers
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    async function handleIncomingMessage(data) {
      const isFromMe = data.sender === window.SDH_DATA.currentUser;

      if (isFromMe && data.message_id) {
        // Server echo: upgrade the optimistic temp bubble to the real ID
        _upgradeTempBubble(data.message_id);
        _setMsgStatus(data.message_id, 'sent');
        renderedIds.add(String(data.message_id));
        return;
      }

      const displayContent = data.message_type === 'text' ? (data.message || '') : null;

      if (data.sender !== activeUser) {
        unreadCounts[data.sender] = (unreadCounts[data.sender] || 0) + 1;
        updateUnreadBadge(data.sender);
        Notif.show(
          `New message from ${data.sender}`,
          data.message_type === 'text' ? (data.message || 'New message') : `📎 ${data.original_filename || 'File'}`,
          `sdh-${data.sender}`,
        );
        return;
      }

      if (renderedIds.has(String(data.message_id))) return;
      renderedIds.add(String(data.message_id));

      appendMessage({
        sender: data.sender, isFromMe: false, content: displayContent,
        messageType: data.message_type,
        originalFilename: data.original_filename, mimeType: data.mime_type,
        timestamp: data.timestamp, messageId: data.message_id,
      });
      scrollToBottom();

      if (SDH.WS.isOpen()) {
        SDH.WS.sendMessage({ type: 'delivered_receipt', message_id: data.message_id });
        SDH.WS.sendMessage({ type: 'read_receipt' });
      }
    }

    async function handleIncomingFileNotification(data) {
      const isFromMe = data.sender === window.SDH_DATA.currentUser;
      if (isFromMe) return; // sender already rendered optimistically

      if (data.sender !== activeUser) {
        unreadCounts[data.sender] = (unreadCounts[data.sender] || 0) + 1;
        updateUnreadBadge(data.sender);
        Notif.show(
          `New file from ${data.sender}`,
          `📎 ${data.original_filename || 'File'}`,
          `sdh-${data.sender}`,
        );
        return;
      }

      if (renderedIds.has(String(data.message_id))) return;
      renderedIds.add(String(data.message_id));

      appendMessage({
        sender: data.sender, isFromMe: false, content: null,
        messageType: data.message_type,
        originalFilename: data.original_filename, mimeType: data.mime_type,
        timestamp: data.timestamp, messageId: data.message_id,
        hasServerFile: true, fileId: data.file_id,
      });
      scrollToBottom();

      if (SDH.WS.isOpen()) {
        SDH.WS.sendMessage({ type: 'delivered_receipt', message_id: data.message_id });
        SDH.WS.sendMessage({ type: 'read_receipt' });
      }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Message bubble renderer
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // ═════════════════════════════════════════════════════════════════════
    //  Professional Message Removal Handlers (Step 3 & 4)
    // ═════════════════════════════════════════════════════════════════════

    function handleMessageRemoved(data) {
      const { message_id, removal_scope, removed_by } = data;
      const bubble = document.getElementById(`msg-${message_id}`);

      if (removal_scope === 'self') {
        // Only affect the user who initiated the removal
        if (removed_by === window.SDH_DATA.currentUser) {
          bubble?.remove();
        }
      } else if (removal_scope === 'all') {
        // Replace bubble content for everyone in the chat
        if (bubble) {
          const msgBubble = bubble.querySelector('.msg-bubble');
          if (msgBubble) {
            msgBubble.innerHTML = `<p class="text-sm italic opacity-50 select-none">This message has been deleted.</p>`;
          }
          bubble.querySelectorAll('.msg-menu-wrap').forEach(el => el.remove());
        }
      }
    }

    /** Toggle the three-dot dropdown for a specific message bubble. */
    function _toggleMsgMenu(btn) {
      const dropdown = btn.nextElementSibling;
      if (!dropdown) return;
      document.querySelectorAll('.msg-dropdown:not(.hidden)').forEach(d => {
        if (d !== dropdown) d.classList.add('hidden');
      });
      dropdown.classList.toggle('hidden');
    }

    /** "Remove from My View" — hides the message only for the current user. */
    async function _removeFromMyView(btn) {
      const bubble = btn.closest('[data-message-id]');
      const msgId  = bubble?.dataset?.messageId;
      if (!msgId || msgId.startsWith('temp_')) return;
      btn.closest('.msg-dropdown')?.classList.add('hidden');
      try {
        const res = await fetch(`/messaging/api/message/${msgId}/remove-my-view/`, {
          method: 'POST',
          headers: { 'X-CSRFToken': window.SDH_DATA.csrfToken, 'Content-Type': 'application/json' },
        });
        if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || res.statusText); }
        bubble.remove();
        showToast('Message removed from your view.', 'success');
      } catch (err) { showToast('Could not remove message: ' + err.message, 'error'); }
    }

    /** Opens the confirmation modal for "Delete for All Participants". */
    function _confirmDeleteForAll(btn) {
      const bubble = btn.closest('[data-message-id]');
      const msgId  = bubble?.dataset?.messageId;
      if (!msgId || msgId.startsWith('temp_')) return;
      btn.closest('.msg-dropdown')?.classList.add('hidden');
      const modal = document.getElementById('deleteForAllModal');
      if (modal) { modal.dataset.targetId = msgId; modal.classList.remove('hidden'); }
    }

    /** Executes the confirmed "Delete for All Participants" action. */
    async function executeDeleteForAll() {
      const modal = document.getElementById('deleteForAllModal');
      const msgId = modal?.dataset?.targetId;
      if (modal) modal.classList.add('hidden');
      if (!msgId) return;
      try {
        const res = await fetch(`/messaging/api/message/${msgId}/delete-for-all/`, {
          method: 'POST',
          headers: { 'X-CSRFToken': window.SDH_DATA.csrfToken, 'Content-Type': 'application/json' },
        });
        if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || res.statusText); }
        showToast('Message deleted for all participants.', 'success');
      } catch (err) { showToast('Could not delete message: ' + err.message, 'error'); }
    }

    // Close open dropdowns on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.msg-menu-wrap')) {
        document.querySelectorAll('.msg-dropdown:not(.hidden)').forEach(d => d.classList.add('hidden'));
      }
    }, true);

    // Close open user-context dropdowns on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.user-ctx-wrap') && !e.target.closest('.user-ctx-dropdown')) {
        _closeAllUserMenus();
      }
    }, true);

    // ═════════════════════════════════════════════════════════════════════
    //  "Remove from My List" — sidebar user context menu
    // ═════════════════════════════════════════════════════════════════════

    /** Toggle the three-dot dropdown for a specific sidebar user item. */
    function _toggleUserMenu(btn) {
      const dropdown = btn.nextElementSibling;
      if (!dropdown) return;

      // Close all other open user dropdowns first
      _closeAllUserMenus(dropdown);

      const wasVisible = !dropdown.classList.contains('hidden');

      if (wasVisible) {
        // Hide it and return to original DOM position
        dropdown.classList.add('hidden');
        dropdown.style.cssText = '';
        // Move back to original parent if appended to body
        if (dropdown._originalParent && dropdown.parentElement === document.body) {
          dropdown._originalParent.appendChild(dropdown);
          delete dropdown._originalParent;
        }
        return;
      }

      // Remember original parent so we can move it back later
      dropdown._originalParent = dropdown.parentElement;

      // Append to body so it escapes all overflow clipping
      document.body.appendChild(dropdown);

      // Show it (remove hidden) so we can measure
      dropdown.classList.remove('hidden');

      // Position fixed relative to the button
      const rect = btn.getBoundingClientRect();
      const dropdownWidth  = dropdown.offsetWidth  || 208;
      const dropdownHeight = dropdown.offsetHeight || 50;

      let top  = rect.bottom + 4;
      let left = rect.right - dropdownWidth;

      // Keep within viewport
      if (left < 8) left = 8;
      if (top + dropdownHeight > window.innerHeight) {
        top = rect.top - dropdownHeight - 4;
      }

      dropdown.style.position = 'fixed';
      dropdown.style.top      = top + 'px';
      dropdown.style.left     = left + 'px';
      dropdown.style.zIndex   = '9999';
    }

    /** Close all open user context dropdowns. */
    function _closeAllUserMenus(except) {
      document.querySelectorAll('.user-ctx-dropdown:not(.hidden)').forEach(d => {
        if (d === except) return;
        d.classList.add('hidden');
        d.style.cssText = '';
        if (d._originalParent && d.parentElement === document.body) {
          d._originalParent.appendChild(d);
          delete d._originalParent;
        }
      });
    }

    /** Opens the "Remove User" confirmation modal for a sidebar contact. */
    function _confirmRemoveUser(userId, username) {
      // Close any open dropdown
      _closeAllUserMenus();
      const modal = document.getElementById('removeUserModal');
      if (!modal) return;
      modal.dataset.targetUserId = userId;
      modal.dataset.targetUsername = username;
      const nameEl = document.getElementById('removeUserModalName');
      if (nameEl) nameEl.textContent = username;
      modal.classList.remove('hidden');
    }

    /** Executes the confirmed "Remove from My List" action. */
    async function executeRemoveUser() {
      const modal = document.getElementById('removeUserModal');
      if (!modal) return;
      const userId   = modal.dataset.targetUserId;
      const username = modal.dataset.targetUsername;
      modal.classList.add('hidden');
      if (!userId) return;

      try {
        const res = await fetch(window.SDH_DATA.removeUserUrl, {
          method: 'POST',
          headers: {
            'X-CSRFToken': window.SDH_DATA.csrfToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ target_user_id: parseInt(userId, 10) }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error(b.error || res.statusText);
        }
        // Remove the user item from sidebar immediately
        const item = document.getElementById(`user-item-${username}`);
        if (item) item.remove();
        _updateOnlineCount();
        // If this was the active conversation, reset panel
        if (activeUser === username) {
          activeUser = null;
          activeUserId = null;
          SDH.WS?.disconnect?.();
          sessionStorage.removeItem('ndm_last_chat');
          sessionStorage.removeItem('ndm_last_chat_id');
          const container = document.getElementById('messagesContainer');
          if (container) {
            container.innerHTML = '';
            const emptyState = document.createElement('div');
            emptyState.id = 'emptyState';
            emptyState.className = 'flex flex-col items-center justify-center h-full text-center sdh-empty-state';
            emptyState.innerHTML = '<p class="text-sm text-divine-muted">Select a contact to begin</p>';
            container.appendChild(emptyState);
          }
          document.getElementById('chatUsername')?.textContent && (document.getElementById('chatUsername').textContent = 'Select a contact');
          document.getElementById('callButtons')?.classList.add('hidden');
        }
        showToast(`${username} removed from your list.`, 'success');
      } catch (err) {
        showToast('Could not remove user: ' + err.message, 'error');
      }
    }

    /**
     * Handles the "user_removed" WebSocket event.
     * Sent by the server when the current user hides someone
     * (optional real-time confirmation path).
     */
    function handleUserRemoved(data) {
      const username = data.removed_username;
      if (!username) return;
      const item = document.getElementById(`user-item-${username}`);
      if (item) item.remove();
      _updateOnlineCount();
    }

    // ═════════════════════════════════════════════════════════════════════
    //  Clear All Chat Handlers
    // ═════════════════════════════════════════════════════════════════════

    /** Handles the real-time chat_cleared event for both participants. */
    function handleChatCleared(data) {
      const { cleared_by, other_user } = data;
      const me = window.SDH_DATA.currentUser;
      // Only act if the cleared conversation is the currently open one
      const partner = cleared_by === me ? other_user : cleared_by;
      if (activeUser !== partner) return;

      renderedIds.clear();
      dateSeparators.clear();

      const container = document.getElementById('messagesContainer');
      if (container) {
        container.innerHTML = `
          <div class="flex flex-col items-center justify-center h-full text-center text-divine-muted py-16">
            <div class="text-5xl mb-4 opacity-20">&#x1F4AC;</div>
            <p class="text-sm font-medium">No messages yet</p>
            <p class="text-xs mt-2 opacity-50">Start a conversation</p>
          </div>`;
      }

      if (cleared_by !== me) {
        showToast(`${cleared_by} cleared the chat history.`, 'info');
      } else {
        showToast('Chat history cleared.', 'success');
      }
    }

    /** Opens the Clear All Chat confirmation modal. */
    function _confirmClearChat() {
      if (!activeUser) return;
      document.getElementById('clearChatModal')?.classList.remove('hidden');
    }

    /** POSTs the clear-chat request after user confirms. */
    async function executeClearChat() {
      document.getElementById('clearChatModal')?.classList.add('hidden');
      if (!activeUser) return;
      try {
        const res = await fetch(`/messaging/api/clear-chat/${activeUser}/`, {
          method: 'POST',
          headers: { 'X-CSRFToken': window.SDH_DATA.csrfToken, 'Content-Type': 'application/json' },
        });
        if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || res.statusText); }
        // UI cleared by the chat_cleared WebSocket event
      } catch (err) { showToast('Could not clear chat: ' + err.message, 'error'); }
    }

    /** Map: date-label string → separator DOM element (one per date). */
    const dateSeparators = new Map();

    function appendMessage(opts) {
      const container = document.getElementById('messagesContainer');
      if (!container) return;
      document.getElementById('emptyState')?.remove();

      const {
        sender, isFromMe, content, messageType,
        originalFilename, mimeType, timestamp, messageId,
        hasServerFile = false, fileId = null,
        isDelivered = false, isRead = false,
      } = opts;

      // â”€â”€ Date separator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (timestamp) {
        const label = _dateLabel(timestamp);
        if (!dateSeparators.has(label)) {
          const sep = document.createElement('div');
          sep.className = 'flex items-center gap-3 my-4 px-2 select-none';
          sep.innerHTML = `
            <div class="flex-1 h-px bg-divine-border/40"></div>
            <span class="text-[11px] text-divine-muted/50 font-medium px-2
                        bg-divine-deep rounded-full border border-divine-border/30 py-0.5">
              ${escapeHtml(label)}
            </span>
            <div class="flex-1 h-px bg-divine-border/40"></div>`;
          container.appendChild(sep);
          dateSeparators.set(label, sep);
        }
      }

      const time = timestamp
        ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';


      const innerHtml = _buildMessageContent({
        messageType, content, originalFilename, mimeType, hasServerFile, fileId,
      });

      const isTemp = String(messageId).startsWith('temp_');

      // Determine initial tick status for outgoing messages
      let initTickStatus = '';
      if (isFromMe && !isTemp) {
        if (isRead)           initTickStatus = 'read';
        else if (isDelivered) initTickStatus = 'delivered';
        else                  initTickStatus = 'sent';
      }

      const menuHtml = isTemp ? '' : `
        <div class="msg-menu-wrap flex-shrink-0 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-150 relative self-center">
          <button onclick="SDH.Chat._toggleMsgMenu(this)"
                  class="w-7 h-7 flex items-center justify-center rounded-full text-divine-muted/50 hover:text-divine-gold hover:bg-divine-card/80 border border-transparent hover:border-divine-border/60 transition-all leading-none select-none"
                  title="Message options">⋯</button>
          <div class="msg-dropdown hidden absolute ${isFromMe ? 'right-0' : 'left-0'} top-full mt-1 z-[35] w-56 bg-divine-card border border-divine-border/80 rounded-xl shadow-2xl overflow-hidden py-1">
            <button onclick="SDH.Chat._removeFromMyView(this)"
                    class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-divine-muted hover:text-divine-text hover:bg-divine-surface transition-colors text-left">
              <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/>
              </svg>
              Remove from My View
            </button>
            ${isFromMe ? `
            <div class="border-t border-divine-border/40 mx-2 my-0.5"></div>
            <button onclick="SDH.Chat._confirmDeleteForAll(this)"
                    class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-red-400/80 hover:text-red-300 hover:bg-red-950/40 transition-colors text-left">
              <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
              </svg>
              Delete for All Participants
            </button>` : ''}
          </div>
        </div>`;

      const bubble = document.createElement('div');
      bubble.id        = `msg-${messageId}`;
      bubble.dataset.messageId = String(messageId);
      bubble.className = `flex ${isFromMe ? 'justify-end' : 'justify-start'} items-center gap-1.5 px-1 mb-1.5 animate-msg-appear group/msg`;
      bubble.innerHTML = `
        ${isFromMe ? menuHtml : ''}
        <div class="max-w-[72%] space-y-0.5">
          ${!isFromMe
            ? `<p class="text-[11px] font-semibold text-divine-muted/70 pl-1 mb-0.5">${escapeHtml(sender)}</p>`
            : ''}
          <div class="msg-bubble px-3.5 py-2.5 rounded-2xl transition-shadow duration-300
            ${isFromMe
              ? 'bg-gradient-to-br from-divine-gold to-divine-amber text-divine-deep rounded-tr-sm shadow-glow-gold/30 hover:shadow-glow-gold'
              : 'bg-divine-card border border-divine-border/80 text-divine-text rounded-tl-sm shadow-sm hover:shadow-divine'}">
            ${innerHtml}
          </div>
          <div class="flex items-center gap-1 ${isFromMe ? 'justify-end pr-0.5' : 'justify-start pl-0.5'}">
            <span class="text-[11px] text-divine-muted/40 select-none">${time}</span>
            ${isFromMe ? `<span class="msg-status-tick leading-none select-none">${_tickHtml(initTickStatus)}</span>` : ''}
          </div>
        </div>
        ${!isFromMe ? menuHtml : ''}`;
      container.appendChild(bubble);
    }

    function _buildMessageContent({ messageType, content, originalFilename, mimeType,
                                    hasServerFile, fileId }) {
      if (messageType === 'deleted') {
        return `<p class="text-sm italic opacity-50 select-none">This message has been deleted.</p>`;
      }

      if (messageType === 'text') {
        return `<p class="text-sm leading-relaxed break-words whitespace-pre-wrap">${escapeHtml(content || '')}</p>`;
      }

      const _esc = s => (s || '').replace(/'/g, '&#039;').replace(/"/g, '&quot;');

      if (messageType === 'image') {
        if (hasServerFile && fileId) {
          const fid = Number(fileId);
          setTimeout(() => {
            const imgEl = document.querySelector(`img[data-file-id="${fid}"][data-sdh-loaded=""]`);
            if (imgEl) SDH.FileUpload.downloadImage({ messageId: fid, mimeType, imgEl })
                        .catch(e => console.error('[Chat] img load:', e));
          }, 120);
          return `
            <div class="file-msg">
              <img src="" data-file-id="${fid}"
                  data-mime="${_esc(mimeType || 'image/jpeg')}" data-sdh-loaded=""
                  alt="${escapeHtml(originalFilename)}"
                  onclick="SDH.FileUpload.downloadImage({messageId:${fid},mimeType:this.dataset.mime,imgEl:this})"
                  class="max-w-xs max-h-52 rounded-xl object-cover cursor-pointer
                          border border-divine-border/40 hover:opacity-90 transition-opacity bg-divine-card/50"
                  loading="lazy" style="min-width:80px;min-height:60px;" />
              <p class="text-[11px] text-divine-muted mt-1">${escapeHtml(originalFilename)}</p>
            </div>`;
        }
        return `
          <div class="file-msg">
            <img src="#" data-mime="${_esc(mimeType)}"
                alt="${escapeHtml(originalFilename)}"
                class="max-w-xs max-h-52 rounded-xl object-cover
                        border border-divine-border/40 bg-divine-card/50"
                loading="lazy" />
            <p class="text-[11px] text-divine-muted mt-1">${escapeHtml(originalFilename)}</p>
          </div>`;
      }

      if (messageType === 'video') {
        if (hasServerFile && fileId) {
          const fid = Number(fileId);
          return `
            <div class="file-msg">
              <div class="flex items-center gap-2.5 p-3 rounded-xl bg-divine-deep/60
                          border border-divine-border/50 cursor-pointer hover:border-divine-gold/40 transition-all"
                  onclick="SDH.FileUpload.downloadFile({messageId:${fid},fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType || 'video/mp4')}',buttonEl:this})">
                <span class="text-2xl select-none">🎬</span>
                <div class="min-w-0">
                  <p class="text-sm font-medium text-divine-text truncate">${escapeHtml(originalFilename)}</p>
                  <p class="text-xs text-divine-muted">Video · tap to download</p>
                </div>
              </div>
            </div>`;
        }
        return `
          <div class="file-msg">
            <div class="flex items-center gap-2.5 p-3 rounded-xl bg-divine-deep/60
                        border border-divine-border/50">
              <span class="text-2xl select-none">🎬</span>
              <div class="min-w-0">
                <p class="text-sm font-medium text-divine-text truncate">${escapeHtml(originalFilename)}</p>
                <p class="text-xs text-divine-muted">Video</p>
              </div>
            </div>
          </div>`;
      }

      // Generic file
      const fileIcon = '📄';
      if (hasServerFile && fileId) {
        const fid = Number(fileId);
        return `
          <div class="file-msg">
            <div class="flex items-center gap-3 p-3 rounded-xl bg-divine-deep/60
                        border border-divine-border/50 cursor-pointer hover:border-divine-gold/40 transition-all"
                onclick="SDH.FileUpload.downloadFile({messageId:${fid},fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType || 'application/octet-stream')}',buttonEl:this})">
              <span class="text-2xl select-none">${fileIcon}</span>
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-divine-text truncate">${escapeHtml(originalFilename)}</p>
                <p class="text-xs text-divine-muted">Tap to download</p>
              </div>
              <svg class="w-4 h-4 flex-shrink-0 text-divine-muted/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
            </div>
          </div>`;
      }
      return `
        <div class="file-msg">
          <div class="flex items-center gap-3 p-3 rounded-xl bg-divine-deep/60
                      border border-divine-border/50">
            <span class="text-2xl select-none">${fileIcon}</span>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium text-divine-text truncate">${escapeHtml(originalFilename)}</p>
              <p class="text-xs text-divine-muted">File</p>
            </div>
            <svg class="w-4 h-4 flex-shrink-0 text-divine-muted/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
            </svg>
          </div>
        </div>`;
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Send message
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    async function sendMessage() {
      if (!activeUser || !activeUserId) return;
      if (!SDH.WS.isOpen()) {
        showToast('Connection lost. Reconnecting...', 'warning');
        SDH.WS.connectWebSocket(activeUserId);
        return;
      }

      const input   = document.getElementById('messageInput');
      const rawText = input.value.trim();
      if (!rawText && !pendingFile) return;

      try {
        if (pendingFile) {
          const { file } = pendingFile;
          clearFile();
          showToast('Uploading file...', 'info');
          let msgData;
          try {
            msgData = await SDH.FileUpload.handleFileUpload(
              file, activeUser, stage => console.debug('[Chat] File upload:', stage),
            );
          } catch (uploadErr) {
            console.error('[Chat] File upload error:', uploadErr);
            showToast(uploadErr.message || 'File upload failed.', 'error');
            return;
          }
          const tempId = `temp_${Date.now()}`;
          appendMessage({
            sender: window.SDH_DATA.currentUser, isFromMe: true, content: null,
            messageType: msgData.message_type,
            originalFilename: msgData.original_filename, mimeType: msgData.mime_type,
            timestamp: msgData.timestamp, messageId: tempId,
            hasServerFile: true, fileId: msgData.file_id,
          });
          scrollToBottom();
          showToast('File sent \u2713', 'success');
          return;
        }

        // Text message
        const payload = { type: 'chat_message', receiver: activeUser, message_type: 'text', message: rawText };

        const tempId = `temp_${Date.now()}`;
        appendMessage({
          sender: window.SDH_DATA.currentUser, isFromMe: true,
          content: rawText, messageType: 'text',
          originalFilename: '', mimeType: '',
          timestamp: new Date().toISOString(), messageId: tempId,
        });
        pendingAckMap.set(tempId, null);
        scrollToBottom();
        stopTyping();
        input.value = '';
        input.style.height = 'auto';

        SDH.WS.sendMessage(payload);

      } catch (err) {
        console.error('[Chat] Send error:', err);
        showToast('Failed to send message: ' + err.message, 'error');
      }
    }

    /** Replace a temp bubble's DOM id with the real server message_id. */
    function _upgradeTempBubble(realId) {
      for (const [tempId, val] of pendingAckMap) {
        if (val === null) {
          const bubble = document.getElementById(`msg-${tempId}`);
          if (bubble) {
            bubble.id = `msg-${realId}`;
            bubble.dataset.messageId = String(realId);
            // Inject the 3-dot menu now that we have a real ID
            const existingMenu = bubble.querySelector('.msg-menu-wrap');
            if (!existingMenu) {
              const menuWrap = document.createElement('div');
              menuWrap.className = 'msg-menu-wrap flex-shrink-0 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-150 relative self-center';
              menuWrap.innerHTML = `
                <button onclick="SDH.Chat._toggleMsgMenu(this)"
                        class="w-7 h-7 flex items-center justify-center rounded-full text-divine-muted/50 hover:text-divine-gold hover:bg-divine-card/80 border border-transparent hover:border-divine-border/60 transition-all leading-none select-none"
                        title="Message options">⋯</button>
                <div class="msg-dropdown hidden absolute right-0 top-full mt-1 z-[35] w-56 bg-divine-card border border-divine-border/80 rounded-xl shadow-2xl overflow-hidden py-1">
                  <button onclick="SDH.Chat._removeFromMyView(this)"
                          class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-divine-muted hover:text-divine-text hover:bg-divine-surface transition-colors text-left">
                    <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                            d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/>
                    </svg>
                    Remove from My View
                  </button>
                  <div class="border-t border-divine-border/40 mx-2 my-0.5"></div>
                  <button onclick="SDH.Chat._confirmDeleteForAll(this)"
                          class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-red-400/80 hover:text-red-300 hover:bg-red-950/40 transition-colors text-left">
                    <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                    </svg>
                    Delete for All Participants
                  </button>
                </div>`;
              // For sender (right-aligned) put menu on left side
              bubble.insertBefore(menuWrap, bubble.firstChild);
            }
          }
          pendingAckMap.delete(tempId);
          return;
        }
      }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Delivery / read status
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /**
     * Returns inner HTML for a message status tick.
     *   sent      → single ✓   (white/muted)
     *   delivered → double ✓✓  (white/muted)
     *   read      → double ✓✓  (saffron #FF9933)
     */
    function _tickHtml(status) {
      if (status === 'read') {
        return '<span style="color:#FF9933;font-size:11px;letter-spacing:-1px;">✓✓</span>';
      }
      if (status === 'delivered') {
        return '<span style="color:rgba(255,255,255,0.55);font-size:11px;letter-spacing:-1px;">✓✓</span>';
      }
      if (status === 'sent') {
        return '<span style="color:rgba(255,255,255,0.55);font-size:11px;">✓</span>';
      }
      return '';
    }

    /** Update tick indicator on an already-rendered sender bubble. */
    function _setMsgStatus(messageId, status) {
      if (!messageId) return;
      const bubble = document.getElementById(`msg-${messageId}`);
      if (!bubble) return;
      const tick = bubble.querySelector('.msg-status-tick');
      if (!tick) return;
      tick.innerHTML = _tickHtml(status);
    }

    /** Mark every visible outgoing tick in the current chat as read (saffron). */
    function _markAllSentAsRead() {
      document.querySelectorAll('.msg-status-tick').forEach(tick => {
        tick.innerHTML = _tickHtml('read');
      });
    }

    //  Typing indicator
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    function sendTyping(state) {
      if (SDH.WS.isOpen()) SDH.WS.sendMessage({ type: 'typing', is_typing: state });
    }

    function stopTyping() {
      if (isTyping) { isTyping = false; sendTyping(false); }
      clearTimeout(typingTimer);
    }

    function handleTypingIndicator(data) {
      if (data.sender !== activeUser) return;
      const bubble = document.getElementById('typingBubble');
      const name   = document.getElementById('typingName');
      if (!bubble) return;
      if (data.is_typing) {
        if (name) name.textContent = data.sender;
        bubble.classList.remove('hidden');
        _setHeaderStatus(`${data.sender} is typing...`, 'typing');
        scrollToBottom();
      } else {
        bubble.classList.add('hidden');
        _setHeaderStatus('Active', 'connected');
      }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Presence (online / offline + last seen)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    function handlePresence(data) {
      const isActive = data.status === 'active';

      // Update sidebar status dot using CSS module classes (sdh-online-dot--on/off)
      const dot = document.getElementById(`online-dot-${data.username}`);
      if (dot) {
        dot.classList.remove('sdh-online-dot--on', 'sdh-online-dot--off');
        dot.classList.add(isActive ? 'sdh-online-dot--on' : 'sdh-online-dot--off');
      }

      // Update last-seen sub-label in sidebar
      const lsEl = document.getElementById(`last-seen-${data.username}`);
      if (lsEl) {
        if (isActive) {
          lsEl.textContent = '● Active';
          lsEl.className   = 'text-[11px] sdh-status-active truncate mt-0.5';
        } else if (data.last_seen) {
          lsEl.textContent = 'Last seen ' + _relativeTime(data.last_seen);
          lsEl.className   = 'text-[11px] sdh-status-inactive truncate mt-0.5';
        } else {
          lsEl.textContent = 'Inactive';
          lsEl.className   = 'text-[11px] sdh-status-inactive truncate mt-0.5';
        }
      }

      // Update chat header for the active conversation
      if (data.username === activeUser) {
        if (isActive) {
          _setHeaderStatus('Active', 'connected');
        } else {
          const rel = data.last_seen ? 'Last seen ' + _relativeTime(data.last_seen) : 'Inactive';
          _setHeaderStatus(rel, 'disconnected');
        }
      }

      _reorderSidebar();
    }

    function _reorderSidebar() {
      const list = document.getElementById('userList');
      if (!list) return;
      const items = Array.from(list.querySelectorAll('.user-item'));
      items.sort((a, b) => {
        const aO = document.getElementById(`online-dot-${a.dataset.username}`)?.classList.contains('sdh-online-dot--on') ? 0 : 1;
        const bO = document.getElementById(`online-dot-${b.dataset.username}`)?.classList.contains('sdh-online-dot--on') ? 0 : 1;
        return aO !== bO ? aO - bO : (a.dataset.username || '').localeCompare(b.dataset.username || '');
      });
      items.forEach(el => list.appendChild(el));
      _updateOnlineCount();
    }

    function _updateOnlineCount() {
      const active = [...document.querySelectorAll('[id^="online-dot-"]')]
                      .filter(d => d.classList.contains('sdh-online-dot--on')).length;
      const badge  = document.getElementById('onlineCountBadge');
      if (!badge) return;
      if (active > 0) {
        badge.textContent = `${active} active`;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Select user
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    async function selectUser(username, userId) {
      if (activeUser === username) return;
      activeUser = username; activeUserId = userId;
      sessionStorage.setItem('ndm_last_chat', username);
      if (userId) sessionStorage.setItem('ndm_last_chat_id', String(userId));

      renderedIds.clear();
      dateSeparators.clear();

      document.querySelectorAll('.user-item').forEach(el =>
        el.classList.remove('bg-divine-card/90', 'border-l-2', 'border-divine-gold'));
      document.getElementById(`user-item-${username}`)
        ?.classList.add('bg-divine-card/90', 'border-l-2', 'border-divine-gold');

      const avatarEl = document.getElementById('chatAvatar');
      if (avatarEl) avatarEl.textContent = (username[0] || '?').toUpperCase();
      const usernameEl = document.getElementById('chatUsername');
      if (usernameEl) usernameEl.textContent = username;

      _setHeaderStatus('Connecting...', 'reconnecting');
      document.getElementById('callButtons')?.classList.remove('hidden');

      const container = document.getElementById('messagesContainer');
      if (container) container.innerHTML = `
        <div class="flex items-center justify-center py-8">
          <div class="w-5 h-5 border-2 border-divine-gold border-t-transparent rounded-full animate-spin"></div>
        </div>`;

      unreadCounts[username] = 0;
      updateUnreadBadge(username);

      if (activeUserId) SDH.WS.connectWebSocket(activeUserId);
      await loadHistory(username);
      closeSidebar();
      SDH.WebRTC?.setRemoteUser(username);
      Notif.requestPermission();
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Load history
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    async function loadHistory(username) {
      const container = document.getElementById('messagesContainer');
      try {
        const res  = await fetch(`${window.SDH_DATA?.historyUrl || '/messaging/api/history/'}${username}/`);
        if (!res.ok) throw new Error(res.statusText);
        const data = await res.json();

        if (container) container.innerHTML = '';
        dateSeparators.clear();

        if (data.messages.length === 0) {
          if (container) container.innerHTML = `
            <div class="flex flex-col items-center justify-center h-full text-center text-divine-muted py-16">
              <div class="text-5xl mb-4 opacity-20">&#x1F4AC;</div>
              <p class="text-sm font-medium">No messages yet</p>
              <p class="text-xs mt-2 opacity-50">Start a conversation</p>
            </div>`;
          _setHeaderStatus('Active', 'connected');
          return;
        }

        for (const msg of data.messages) {
          const isFromMe = msg.sender === window.SDH_DATA.currentUser;
          // Deleted-for-all messages render as a placeholder; no menu shown
          const effectiveType = msg.is_deleted_for_all ? 'deleted' : msg.message_type;
          const content  = effectiveType === 'text' ? (msg.message || '') : null;
          renderedIds.add(String(msg.id));
          appendMessage({
            sender: msg.sender, isFromMe, content,
            messageType: effectiveType,
            originalFilename: msg.original_filename, mimeType: msg.mime_type,
            timestamp: msg.timestamp, messageId: msg.id,
            hasServerFile: !msg.is_deleted_for_all && (msg.has_file || false),
            fileId: msg.is_deleted_for_all ? null : (msg.file_id || null),
            isDelivered: msg.is_delivered || false,
            isRead: msg.is_read || false,
          });
        }

        _setHeaderStatus('Active', 'connected');
        scrollToBottom(true);
      } catch (err) {
        console.error('[Chat] loadHistory error:', err);
        if (container) container.innerHTML = `
          <p class="text-center text-red-400/70 text-sm py-8">Failed to load messages.</p>`;
      }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Unread counts
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    async function loadUnreadCounts() {
      try {
        const res  = await fetch('/messaging/api/unread/');
        const data = await res.json();
        unreadCounts = data.unread || {};
        Object.entries(unreadCounts).forEach(([u, c]) => { if (c > 0) updateUnreadBadge(u); });
      } catch { /* non-critical */ }
    }

    function updateUnreadBadge(username) {
      const badge = document.getElementById(`unread-${username}`);
      if (!badge) return;
      const count = unreadCounts[username] || 0;
      if (count > 0) { badge.textContent = count > 99 ? '99+' : String(count); badge.classList.remove('hidden'); }
      else badge.classList.add('hidden');
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Input handlers
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    function onInput(el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 128) + 'px';
      if (!isTyping && activeUser) { isTyping = true; sendTyping(true); }
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { isTyping = false; sendTyping(false); }, TYPING_TIMEOUT);
    }

    function onKeyDown(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  File handling
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    function handleFileSelect(input) {
      const file = input.files[0];
      if (!file) return;
      if (file.size > MAX_FILE_SIZE) { showToast('File too large. Maximum 20 MB.', 'error'); input.value = ''; return; }
      const reader = new FileReader();
      reader.onload = (e) => {
        pendingFile = { file, arrayBuffer: e.target.result };
        const preview = document.getElementById('filePreview');
        const name    = document.getElementById('filePreviewName');
        if (preview && name) {
          name.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
          preview.classList.remove('hidden');
        }
      };
      reader.readAsArrayBuffer(file);
      input.value = '';
    }

    function clearFile() {
      pendingFile = null;
      document.getElementById('filePreview')?.classList.add('hidden');
    }


    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Emoji picker
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    function toggleEmojiPicker() { document.getElementById('emojiPicker')?.classList.toggle('hidden'); }

    function insertEmoji(emoji) {
      const input = document.getElementById('messageInput');
      if (input) {
        const pos = input.selectionStart ?? input.value.length;
        input.value = input.value.slice(0, pos) + emoji + input.value.slice(pos);
        input.focus(); input.setSelectionRange(pos + emoji.length, pos + emoji.length);
      }
      document.getElementById('emojiPicker')?.classList.add('hidden');
    }

    document.addEventListener('click', (e) => {
      const picker = document.getElementById('emojiPicker');
      if (picker && !picker.contains(e.target) && !e.target.closest('[onclick*="toggleEmojiPicker"]'))
        picker.classList.add('hidden');
    });

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Sidebar
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    function filterUsers(query) {
      const q = query.toLowerCase();
      document.querySelectorAll('.user-item').forEach(el => {
        el.style.display = (el.dataset.username?.toLowerCase() || '').includes(q) ? '' : 'none';
      });
    }

    function openSidebar() {
      document.getElementById('sidebar')?.classList.remove('-translate-x-full');
      document.getElementById('sidebar')?.classList.add('translate-x-0');
      document.getElementById('sidebarOverlay')?.classList.remove('hidden');
    }

    function closeSidebar() {
      document.getElementById('sidebar')?.classList.remove('translate-x-0');
      document.getElementById('sidebar')?.classList.add('-translate-x-full');
      document.getElementById('sidebarOverlay')?.classList.add('hidden');
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Scroll + Toast
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    function scrollToBottom(instant = false) {
      const el = document.getElementById('messagesContainer');
      if (!el) return;
      if (instant) el.scrollTop = el.scrollHeight;
      else setTimeout(() => { el.scrollTop = el.scrollHeight; }, 50);
    }

    function showToast(message, type = 'info') {
      const colors = {
        info:    'bg-divine-card border-divine-border text-divine-text',
        success: 'bg-green-900/80 border-green-700 text-green-200',
        warning: 'bg-yellow-900/80 border-yellow-700 text-yellow-200',
        error:   'bg-red-900/80 border-red-700 text-red-200',
      };
      const toast = Object.assign(document.createElement('div'), {
        className: `fixed bottom-6 left-1/2 -translate-x-1/2 z-[60]
                    px-5 py-3 rounded-xl border text-sm shadow-2xl animate-slide-in
                    ${colors[type] || colors.info}`,
        textContent: message,
      });
      document.body.appendChild(toast);
      setTimeout(() => {
        toast.style.transition = 'opacity 0.4s';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 400);
      }, 3500);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Bootstrap
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    async function initializeChat() {
      await loadUnreadCounts();
      _updateOnlineCount();
      // Show notification permission banner if not yet decided
      if ('Notification' in window && Notification.permission === 'default') {
        const banner = document.getElementById('notifPrompt');
        if (banner) banner.classList.replace('hidden', 'flex');
      }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Utility
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    function escapeHtml(str) {
      if (typeof str !== 'string') return '';
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
    }

    function _dateLabel(isoString) {
      if (!isoString) return '';
      const d     = new Date(isoString);
      const today = new Date();
      const diffD = Math.floor(
        (new Date(today.getFullYear(), today.getMonth(), today.getDate()) -
        new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000,
      );
      if (diffD === 0) return 'Today';
      if (diffD === 1) return 'Yesterday';
      return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    }

    function _relativeTime(isoString) {
      if (!isoString) return '';
      const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
      if (diff < 60)    return 'just now';
      if (diff < 3600)  return `${Math.floor(diff / 60)} min ago`;
      if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
      return new Date(isoString).toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    // â”€â”€ Aliases â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


    // â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    return {
      initializeChat,
      selectUser,
      sendMessage,
      onInput,
      onKeyDown,
      handleFileSelect,
      clearFile,
      filterUsers,
      openSidebar,
      closeSidebar,
      toggleEmojiPicker,
      insertEmoji,
      loadUnreadCounts,
      showToast,
      _onWsMessage,
      _onWsOpen,
      _onWsClose,
      _onWsReconnecting,
      // Professional deletion
      _toggleMsgMenu,
      _removeFromMyView,
      _confirmDeleteForAll,
      executeDeleteForAll,
      // Clear all chat
      _confirmClearChat,
      executeClearChat,
      // Remove user from my list
      _toggleUserMenu,
      _confirmRemoveUser,
      executeRemoveUser,
    };

  })();
