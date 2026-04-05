# Sandesh

Sandesh is a real-time messaging app built with Django, Django Channels, and WebRTC. It is made for simple one-to-one communication: fast chat, voice and video calls, file sharing, and live presence updates.

The idea is to keep the experience direct and easy to use. You sign in, find a user, start chatting, and use calls or attachments only when you need them.

## What you can do

- Send and receive messages in real time
- See when someone is online or recently active
- Watch typing indicators while someone is responding
- Share files in the conversation
- Start voice calls or video calls
- Mute your microphone or turn off your camera during a call
- Hide a message only for yourself
- Delete a message for everyone in the chat
- Clear an entire conversation when needed

## How to use it

1. Create an account or log in.
2. Open the chat screen.
3. Search for the person you want to talk to.
4. Start sending messages right away.
5. Use the call buttons if you want to move from chat to voice or video.
6. Attach a file when you want to share something quickly.

If you are testing the app locally, create a superuser so you can also access the admin panel.

## Feature breakdown

### Real-time chat

Messages are delivered instantly through WebSockets. That means you do not need to refresh the page to see new messages, delivery updates, or read receipts.

### Voice and video calls

Calls are handled with WebRTC. Once the connection is established, audio and video stream directly between users. The app also gives you the usual controls you would expect, like mute, camera toggle, and end call.

### File sharing

You can send files inside the chat instead of switching to another app. This is useful for documents, images, and other small attachments you want to share quickly.

### Message controls

Sandesh gives users more control over conversations:

- Remove from my view hides the message only for you.
- Delete for all removes the message for both sides.
- Clear chat removes the full conversation history.

### Presence and typing

The app shows whether people are online and can display typing activity while they are composing a message. This makes the chat feel more alive and less delayed.

## File structure

```text
sdh/
|- manage.py
|- requirements.txt
|- sdh/            # Project settings, ASGI, URLs
|- users/          # Registration, login, profile
|- messaging/      # Chat, APIs, WebSocket consumers
|- templates/      # HTML pages
|- static/         # CSS and JavaScript
`- media/          # Uploaded avatars and shared files
```

## Running the project locally

You only need Python and pip to get started.

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

Then open:

http://127.0.0.1:8000

If you want an admin account, run:

```bash
python manage.py createsuperuser
```

## Notes for development

- Uploaded avatars and shared files are stored in the media folder.
- Static assets are served from the static folder during development.
- Real-time chat depends on Django Channels, so WebSocket support must stay enabled.
- For production, use a proper database and Redis for channel layers.
- If you want calls to work reliably across networks, configure a TURN server.

## Tech stack

- Django 5.x
- Django Channels
- WebRTC
- Vanilla JavaScript
- SQLite for local development

## Maintainer

Built and maintained by Garuda Netra
