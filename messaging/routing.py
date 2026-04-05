"""
Messaging WebSocket URL Routing
"""

from django.urls import re_path
from . import consumers

websocket_urlpatterns = [
    # Real-time chat with a specific user id (primary route)
    re_path(r'^ws/chat/(?P<user_id>\d+)/$', consumers.ChatConsumer.as_asgi()),

    # Backward-compatible route (legacy username path)
    re_path(r'^ws/chat/(?P<username>[\w.@+-]+)/$', consumers.ChatConsumer.as_asgi()),

    # WebRTC signaling with a specific user
    re_path(r'^ws/signal/(?P<username>[\w.@+-]+)/$', consumers.SignalingConsumer.as_asgi()),
]
