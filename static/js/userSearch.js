/**
 * SDH – User Search Module
 * ========================
 * Replaces the client-side filterUsers() with a proper backend-powered
 * live search.  Queries /users/api/search-users/?q=<value> on every
 * keystroke (debounced 280 ms), then re-renders #userList with the
 * results using the same markup structure as the Django template.
 *
 * Public surface:
 *   SDH.UserSearch.init()   – called automatically on DOMContentLoaded
 */

'use strict';

window.SDH = window.SDH || {};

SDH.UserSearch = (() => {

  // ── Constants ────────────────────────────────────────────────
  const SEARCH_URL    = window.SDH_DATA?.searchUsersUrl || '/api/search-users/';
  const DEBOUNCE_MS   = 280;

  // ── State ────────────────────────────────────────────────────
  let debounceTimer   = null;
  let originalHTML    = null;   // server-rendered list (saved once on init)
  let lastQuery       = '';
  let currentAbort    = null;   // AbortController for in-flight requests

  // ── Helpers ──────────────────────────────────────────────────

  /**
   * Escape HTML special characters to prevent XSS when building markup
   * from server data.
   */
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Build the HTML for a single user item – mirrors the updated Django template
   * structure (outer div + clickable inner + three-dot context menu).
   */
  function buildUserItemHTML(user) {
    const initial    = esc(user.username.charAt(0).toUpperCase());
    const username   = esc(user.username);
    const userId     = Number(user.id);
    const dotClass   = user.is_online
      ? 'sdh-online-dot--on'
      : 'sdh-online-dot--off';

    // Avatar: use remote URL when available, fallback to initial circle
    const avatarHTML = user.avatar_url
      ? `<img src="${esc(user.avatar_url)}" alt="${username}"
              class="w-10 h-10 rounded-full object-cover border border-divine-border" />`
      : `<div class="w-10 h-10 rounded-full bg-divine-gold/15 border border-divine-border
                     flex items-center justify-center text-divine-gold text-sm font-semibold">
           ${initial}
         </div>`;

    // Status line
    let statusHTML;
    if (user.is_online) {
      statusHTML = `<p id="last-seen-${username}"
                      class="text-[11px] sdh-status-active truncate mt-0.5">
                      &#9679; Active
                    </p>`;
    } else if (user.last_seen) {
      statusHTML = `<p id="last-seen-${username}"
                      class="text-[11px] sdh-status-inactive truncate mt-0.5">
                      Last seen ${esc(user.last_seen)}
                    </p>`;
    } else {
      statusHTML = `<p id="last-seen-${username}"
                      class="text-[11px] sdh-status-inactive truncate mt-0.5">
                      Ready to chat
                    </p>`;
    }

    return `
      <div id="user-item-${username}"
           class="user-item relative w-full flex items-center gap-3 px-4 py-3.5
                  group/usr transition-all hover:bg-divine-card/70 border-b border-divine-border/30"
           data-username="${username}"
           data-userid="${userId}">

        <!-- Clickable main area -->
        <div class="flex items-center gap-3 flex-1 min-w-0 cursor-pointer"
             onclick="SDH.Chat.selectUser('${username}', ${userId})">

          <!-- Avatar -->
          <div class="relative flex-shrink-0">
            ${avatarHTML}
            <span id="online-dot-${username}"
                  class="sdh-online-dot absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full
                         border-2 border-divine-surface ${dotClass}">
            </span>
          </div>

          <!-- Name + status -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm font-medium text-divine-text truncate">${username}</span>
              <span id="unread-${username}"
                    class="hidden flex-shrink-0 text-xs bg-divine-gold text-divine-deep
                           rounded-full px-1.5 py-0.5 font-bold leading-none">
              </span>
            </div>
            ${statusHTML}
          </div>

        </div><!-- /clickable area -->

        <!-- Three-dot context menu (visible on hover) -->
        <div class="user-ctx-wrap relative flex-shrink-0 z-10
                    opacity-0 group-hover/usr:opacity-100 transition-opacity duration-150"
             onclick="event.stopPropagation()">
          <button onclick="SDH.Chat._toggleUserMenu(this)"
                  class="w-7 h-7 flex items-center justify-center rounded-full
                         text-divine-muted/50 hover:text-divine-gold hover:bg-divine-card/80
                         border border-transparent hover:border-divine-border/60
                         transition-all leading-none select-none"
                  title="User options">&#x22EF;</button>
          <div class="user-ctx-dropdown hidden absolute right-0 top-full mt-1 z-[35]
                      w-52 bg-divine-card border border-divine-border/80 rounded-xl
                      shadow-2xl overflow-hidden py-1">
            <button onclick="SDH.Chat._confirmRemoveUser('${userId}', '${username}')"
                    class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm
                           text-divine-muted hover:text-divine-text hover:bg-divine-surface
                           transition-colors text-left">
              <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M13 7a4 4 0 11-8 0 4 4 0 018 0zM9 14a6 6 0 00-6 6v1h12v-1
                         a6 6 0 00-6-6zM21 12h-6"/>
              </svg>
              Remove from My List
            </button>
          </div>
        </div><!-- /context menu -->

      </div>`;
  }

  /** Render an empty-state message inside #userList. */
  function renderEmpty(message) {
    const list = document.getElementById('userList');
    if (!list) return;
    list.innerHTML = `
      <div class="flex flex-col items-center justify-center h-full text-center p-6 text-divine-muted">
        <div class="text-4xl mb-3">🔍</div>
        <p class="text-sm">${esc(message)}</p>
      </div>`;
  }

  /** Render a loading skeleton (single-item spinner). */
  function renderLoading() {
    const list = document.getElementById('userList');
    if (!list) return;
    list.innerHTML = `
      <div class="flex items-center justify-center py-8 text-divine-muted">
        <svg class="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10"
                  stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor"
                d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
        <span class="text-xs">Searching…</span>
      </div>`;
  }

  /** Restore the original server-rendered user list. */
  function restoreOriginal() {
    const list = document.getElementById('userList');
    if (!list || originalHTML === null) return;
    list.innerHTML = originalHTML;
  }

  // ── Core search logic ────────────────────────────────────────

  async function performSearch(query) {
    // Cancel any previous in-flight request
    if (currentAbort) currentAbort.abort();
    currentAbort = new AbortController();

    renderLoading();

    try {
      const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'same-origin',
        signal: currentAbort.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      renderResults(data.users || [], query);

    } catch (err) {
      if (err.name === 'AbortError') return;   // superseded by newer request
      console.error('[UserSearch] fetch error:', err);
      renderEmpty('Search unavailable. Please try again.');
    }
  }

  function renderResults(users, query) {
    const list = document.getElementById('userList');
    if (!list) return;

    if (users.length === 0) {
      renderEmpty(`No users found for "${query}".`);
      return;
    }

    list.innerHTML = users.map(buildUserItemHTML).join('');

    // Re-apply any existing unread badges that SDH.Chat tracks
    if (window.SDH?.Chat?.refreshUnreadBadges) {
      SDH.Chat.refreshUnreadBadges();
    }
  }

  // ── Public API / init ────────────────────────────────────────

  /**
   * Override SDH.Chat.filterUsers so the existing oninput handler in the
   * template calls our backend search instead of the old DOM-only filter.
   */
  function patchChatFilter() {
    // Wait until SDH.Chat has been defined (chat.js loads after us)
    const patch = () => {
      if (window.SDH?.Chat?.filterUsers) {
        SDH.Chat.filterUsers = (value) => handleInput(value);
      }
    };
    // Try immediately; if chat.js isn't loaded yet, retry after a tick
    patch();
    window.addEventListener('load', patch, { once: true });
  }

  function handleInput(value) {
    const query = value.trim();

    // Avoid redundant requests
    if (query === lastQuery) return;
    lastQuery = query;

    clearTimeout(debounceTimer);

    if (query === '') {
      if (currentAbort) { currentAbort.abort(); currentAbort = null; }
      restoreOriginal();
      return;
    }

    debounceTimer = setTimeout(() => performSearch(query), DEBOUNCE_MS);
  }

  function init() {
    const input = document.getElementById('searchUsers');
    if (!input) return;

    // Persist the server-rendered HTML so we can restore it later
    const list = document.getElementById('userList');
    if (list) originalHTML = list.innerHTML;

    // Attach our own listener (also works as fallback if patchChatFilter
    // fires before chat.js; both paths end up calling handleInput).
    input.addEventListener('input', (e) => handleInput(e.target.value));

    patchChatFilter();
  }

  // Auto-initialise
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { init };

})();
