/**
 * SDH – File Upload/Download Module
 * ===================================
 * Orchestrates plain (unencrypted) file transfers.
 *
 *   UPLOAD flow
 *   ───────────
 *   1. Validate the file.
 *   2. POST the raw file + metadata to /messaging/upload-file/.
 *   3. Notify the receiver via WebSocket (file_notification message).
 *
 *   DOWNLOAD flow
 *   ─────────────
 *   1. GET /messaging/download-file/<messageId>/ → raw bytes.
 *   2. Trigger browser download / render inline image.
 *
 * Public API (window.SDH.FileUpload):
 *   validateFile(file)                          → void (throws on error)
 *   handleFileUpload(file, receiverUsername)    → Promise<messageData>
 *   downloadFile(opts)                          → Promise<void>
 *   downloadImage(opts)                         → Promise<void>
 */

'use strict';

window.SDH = window.SDH || {};

SDH.FileUpload = (() => {

  // ── Constants ─────────────────────────────────────────────────────────────
  const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

  const ALLOWED_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'video/mp4', 'video/webm', 'video/ogg',
    'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip',
    'application/x-rar-compressed',
    'application/x-7z-compressed',
    'text/plain',
    'text/csv',
  ]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  function _csrf() {
    return (
      window.SDH_DATA?.csrfToken ||
      document.cookie.match(/csrftoken=([^;]+)/)?.[1] ||
      ''
    );
  }

  function _uploadUrl() {
    return window.SDH_DATA?.uploadFileUrl || '/messaging/upload-file/';
  }

  function _downloadUrl(messageId) {
    const base = window.SDH_DATA?.downloadFileUrl || '/messaging/download-file/';
    return `${base}${messageId}/`;
  }

  /**
   * Derive the SDH message_type ('image' | 'video' | 'file') from a MIME type.
   * @param {string} mimeType
   * @returns {'image'|'video'|'file'}
   */
  function _sdhMessageType(mimeType) {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    return 'file';
  }

  // ── Validate file before upload ────────────────────────────────────────────

  /**
   * Validate a File before uploading.
   * @param {File} file
   * @throws {Error} with a user-friendly message.
   */
  function validateFile(file) {
    if (!file) throw new Error('No file selected.');

    if (file.size === 0) throw new Error('Cannot upload an empty file.');

    if (file.size > MAX_FILE_BYTES) {
      const mb = (file.size / 1024 / 1024).toFixed(1);
      throw new Error(`File is too large (${mb} MB). Maximum allowed size is 20 MB.`);
    }

    const mime = file.type || 'application/octet-stream';
    const isAllowed =
      ALLOWED_TYPES.has(mime) ||
      mime.startsWith('image/') ||
      mime.startsWith('video/') ||
      mime.startsWith('audio/');

    if (!isAllowed) {
      throw new Error(`File type "${mime}" is not supported.`);
    }
  }

  // ── Main: handleFileUpload ─────────────────────────────────────────────────

  /**
   * Upload a file to the server for `receiverUsername`.
   *
   * Notifies the receiver via WebSocket after a successful upload so their
   * browser can render the file message bubble immediately.
   *
   * @param {File}   file              The File object selected by the user.
   * @param {string} receiverUsername  Recipient's username.
   * @param {function} [onProgress]    Optional callback(stage: string).
   *
   * @returns {Promise<Object>} Server response JSON with message metadata.
   */
  async function handleFileUpload(file, receiverUsername, onProgress) {
    const _progress = typeof onProgress === 'function' ? onProgress : () => {};

    // ── Guard: file ──────────────────────────────────────────────────────────
    validateFile(file);

    // ── Upload ───────────────────────────────────────────────────────────────
    _progress('Uploading...');
    const form = new FormData();
    form.append('file',         file, file.name);
    form.append('file_name',    file.name);
    form.append('receiver',     receiverUsername);
    form.append('mime_type',    file.type || 'application/octet-stream');
    form.append('message_type', _sdhMessageType(file.type));

    const response = await fetch(_uploadUrl(), {
      method:  'POST',
      headers: { 'X-CSRFToken': _csrf() },
      body:    form,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Upload failed (HTTP ${response.status}).`);
    }

    _progress('Done.');

    // ── Notify receiver via WebSocket ────────────────────────────────────────
    if (SDH.WS && SDH.WS.isOpen()) {
      SDH.WS.sendMessage({
        type:              'file_notification',
        message_id:        data.message_id,
        file_id:           data.file_id,
        message_type:      data.message_type,
        original_filename: data.original_filename,
        mime_type:         data.mime_type,
        timestamp:         data.timestamp,
        has_file:          true,
      });
    }

    return data;
  }

  // ── downloadFile ──────────────────────────────────────────────────────────

  /**
   * Fetch a file from the server and trigger a browser download dialog.
   *
   * @param {{
   *   messageId: number,
   *   fileName:  string,
   *   mimeType:  string,
   *   buttonEl?: HTMLElement,
   * }} opts
   */
  async function downloadFile({ messageId, fileName, mimeType, buttonEl }) {
    if (!messageId) throw new Error('Missing messageId; cannot download.');

    if (buttonEl) {
      buttonEl.style.opacity       = '0.5';
      buttonEl.style.pointerEvents = 'none';
    }

    try {
      const response = await fetch(_downloadUrl(messageId), { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}).`);

      const blob = await response.blob();
      const url  = URL.createObjectURL(
        new Blob([await blob.arrayBuffer()], { type: mimeType || 'application/octet-stream' }),
      );
      const a = document.createElement('a');
      a.href     = url;
      a.download = fileName || 'sdh_file';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 30_000);

    } finally {
      if (buttonEl) {
        buttonEl.style.opacity       = '1';
        buttonEl.style.pointerEvents = 'auto';
      }
    }
  }

  // ── downloadImage ─────────────────────────────────────────────────────────

  /**
   * Fetch an image from the server and set it as the `src` of an `<img>`
   * element for inline display.
   *
   * @param {{
   *   messageId: number,
   *   mimeType:  string,
   *   imgEl:     HTMLImageElement,
   * }} opts
   */
  async function downloadImage({ messageId, mimeType, imgEl }) {
    if (!messageId || !imgEl) return;

    // Prevent double-loading
    if (imgEl.dataset.sdhLoaded === '1') return;
    imgEl.dataset.sdhLoaded = '1';

    try {
      const response = await fetch(_downloadUrl(messageId), { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const blob = await response.blob();
      imgEl.src  = URL.createObjectURL(
        new Blob([await blob.arrayBuffer()], { type: mimeType || 'image/jpeg' }),
      );
    } catch (err) {
      console.error('[FileUpload] Image download error:', err);
      imgEl.dataset.sdhLoaded = ''; // allow retry
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    validateFile,
    handleFileUpload,
    downloadFile,
    downloadImage,
  };

})();
