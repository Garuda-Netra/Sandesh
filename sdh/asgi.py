"""
ASGI config for SDH project.
Handles both HTTP and WebSocket connections via Django Channels.
"""

import os
import django
from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack
from channels.security.websocket import AllowedHostsOriginValidator

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'sdh.settings')
django.setup()

import messaging.routing as messaging_routing

application = ProtocolTypeRouter({
    'http': get_asgi_application(),
    'websocket': AllowedHostsOriginValidator(
        AuthMiddlewareStack(
            URLRouter(
                messaging_routing.websocket_urlpatterns
            )
        )
    ),
})
