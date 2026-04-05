# Sandesh – Modern Web Messaging Platform

> Sandesh is a production-ready, real-time web messaging application built on Django Channels and WebRTC.
> It supports instant chat, peer-to-peer voice/video calls, file sharing, and live presence indicators —
> all within a lightweight, zero-dependency vanilla JS frontend.

---

## Features

| Feature | Description |
|---|---|
| Real-time Chat | Instant message delivery via WebSocket (Django Channels / ASGI) |
| Voice Calls | WebRTC peer-to-peer audio calls with mute control |
| Video Calls | WebRTC peer-to-peer video calls with local/remote preview and mute/camera toggle |
| Global Signaling | Personal inbox groups (`user_<id>`) — any user can call any other user dynamically |
| File Sharing | Secure upload and download of files up to 20 MB |
| Online Presence | Live online/offline status with last-seen timestamps, broadcast to all connections |
| Typing Indicators | Real-time typing notifications with debounce |
| Message Status | Sent → Delivered → Read receipt chain |
| Remove from My View | Hide any message from your personal view without affecting others |
| Delete for All | Permanently remove a message for all participants; attached file deleted from storage |
| Clear Chat | Wipe an entire conversation for both participants simultaneously |
| Push Notifications | Browser Notification API support for background message alerts |
| Modern Cosmic UI | Animated purple/cosmic Tailwind CSS theme — no redesign required |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.11+ · Django 5.x · Django Channels (ASGI) · Daphne |
| Frontend | HTML5 · Tailwind CSS · Vanilla JavaScript (no frameworks) |
| Real-time Chat | WebSockets — `ChatConsumer` via Django Channels |
| WebRTC Signaling | WebSockets — `SignalingConsumer`, personal user-inbox groups (`user_<id>`) |
| Database | SQLite (development) · PostgreSQL (production-ready) |
| Channel Layer | In-memory (development) · Redis (production) |

---

## Project Structure

```
sdh/
├── messaging/              # Core messaging app
│   ├── consumers.py        # ChatConsumer + SignalingConsumer (WebSocket handlers)
│   ├── models.py           # Message model
│   ├── routing.py          # WebSocket URL patterns
│   ├── views.py            # HTTP API views (history, upload, download, etc.)
│   └── urls.py
├── users/                  # User registration, authentication, profiles
├── static/
│   ├── js/
│   │   ├── webrtc.js       # WebRTC module (voice/video/mute/signaling)
│   │   ├── websocket.js    # Chat WebSocket transport
│   │   ├── chat.js         # Chat UI logic
│   │   ├── fileUpload.js   # File attachment handling
│   │   └── userSearch.js   # Contact search
│   └── css/
│       └── custom.css
├── templates/
│   ├── base.html
│   ├── messaging/
│   │   └── chat.html       # Main chat & call UI
│   └── users/
│       └── profile.html
├── sdh/                    # Django project settings & ASGI config
├── manage.py
└── requirements.txt
```

---

## Setup Instructions

### 1. Prerequisites

- Python 3.11 or higher
- pip

### 2. Clone & Install

```bash
git clone <repository-url>
cd sdh

# Create and activate virtual environment
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
```

### 3. Apply Migrations

```bash
python manage.py migrate
```

### 4. Create a Superuser (optional)

```bash
python manage.py createsuperuser
```

### 5. Collect Static Files

```bash
python manage.py collectstatic --no-input
```

### 6. Start the Development Server

```bash
python manage.py runserver
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) in your browser.

---

## WebRTC Architecture

### Signaling — how calls are routed

```
User A (caller)                   Django Channels                  User B (callee)
──────────────                    ──────────────                   ──────────────
Page loads
  SDH.WebRTC.init("alice")  →  /ws/signal/alice/
                                  group_add("user_<alice_id>")
                                                                   Page loads
                                                                     SDH.WebRTC.init("bob")
                                                               →  /ws/signal/bob/
                                                                     group_add("user_<bob_id>")

  startCall('voice')
  sendSignal({ type:"call-request",
               to_user:"bob" })  →  resolve bob → "user_<bob_id>"
                                  group_send("user_<bob_id>")  → incoming call UI shown

  sendSignal({ type:"offer",
               to_user:"bob" })  →  group_send("user_<bob_id>")  → handleOffer() buffers SDP

                                                                   acceptCall()
                                                                     getUserMedia()
                                 ←  group_send("user_<alice_id")  ←  sendSignal({type:"call-accept"})
                                 ←  group_send("user_<alice_id")  ←  sendSignal({type:"answer"})

  setRemoteDescription(answer)                                     ICE ↔ ICE exchange
  ──────────────────── peer-to-peer media established ─────────────────────────────
```

### Key design decisions

| Decision | Reason |
|---|---|
| Personal inbox group per user (`user_<id>`) | Callee receives signals even before selecting the caller as a contact |
| Persistent signaling socket opened on page load | One socket serves all calls; no teardown when switching contacts |
| `callPeer` variable tracks active peer | All `sendSignal` calls automatically route to the right user |
| ICE candidates buffered until `setRemoteDescription` | Eliminates race conditions on slow networks |
| `_handleMediaError()` maps browser error names | User sees a human-friendly message instead of a raw `DOMException` |
| `AudioContext` oscillator ringtone | No extra audio files needed; works cross-browser |

### WebSocket URL patterns

| Pattern | Consumer | Purpose |
|---|---|---|
| `/ws/chat/<user_id>/` | `ChatConsumer` | Real-time chat with a specific user |
| `/ws/signal/<username>/` | `SignalingConsumer` | WebRTC signaling inbox |

---

## Message Management

### Remove from My View
- Hides the message **only** from the requesting user's view.
- The message record is preserved in the database.
- Other participants are **not** affected.

### Delete for All Participants
- Permanently replaces message content with *"This message has been deleted."* for **all participants**.
- Only the **original sender** can invoke this action.
- Attached files are deleted from storage to prevent orphans.
- Real-time WebSocket broadcast updates all connected clients instantly.

### Clear Chat
- Wipes the entire conversation for **both** participants simultaneously.
- Broadcasts a `chat_cleared` event over WebSocket so both UIs update in real time.

---

## Voice & Video Call Controls

| Control | Behaviour |
|---|---|
| Voice call button | `getUserMedia({ audio: true })` → peer connection → remote audio attached to `<audio>` element |
| Video call button | `getUserMedia({ video: true, audio: true })` → local preview in PIP `<video>`, remote in full-screen `<video>` |
| Mute button | Toggles `audioTrack.enabled` — does **not** stop the track or the peer connection |
| Camera button | Toggles `videoTrack.enabled` |
| Quality selector | Applies `applyConstraints()` on the video track and notifies remote via `call-quality` signal |
| End call button | Closes `RTCPeerConnection`, stops all tracks, sends `call-end` signal, resets UI |

---

## Production Checklist

- [ ] Set `DEBUG = False` in `settings.py`
- [ ] Configure PostgreSQL and update `DATABASES`
- [ ] Switch `CHANNEL_LAYERS` to Redis (see below)
- [ ] Set `SECRET_KEY` via environment variable
- [ ] Configure `ALLOWED_HOSTS`
- [ ] Serve static files via WhiteNoise or a CDN
- [ ] Add TURN server credentials to `ICE_SERVERS` in `static/js/webrtc.js`
- [ ] Run behind Daphne or Uvicorn (ASGI)

### Redis Channel Layer

```python
# settings.py
CHANNEL_LAYERS = {
    'default': {
        'BACKEND': 'channels_redis.core.RedisChannelLayer',
        'CONFIG': { 'hosts': [('127.0.0.1', 6379)] },
    }
}
```

```bash
pip install channels-redis
```

### TURN Server (required for calls across NAT/firewalls)

Edit `ICE_SERVERS` in `static/js/webrtc.js`:

```js
{ urls: 'turn:your.turn.server:3478', username: 'user', credential: 'pass' }
```

Free TURN server option: <https://www.metered.ca/tools/openrelay/>

### Production Server (Daphne)

```bash
daphne -b 0.0.0.0 -p 8000 sdh.asgi:application
```

---

## Attribution

Developed and maintained by **Garuda Netra**
