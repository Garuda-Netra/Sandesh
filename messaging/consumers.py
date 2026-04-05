"""
Messaging WebSocket Consumers

Two consumers:
  1. ChatConsumer  — real-time messaging
  2. SignalingConsumer — WebRTC signaling for voice/video calls
"""

import json
import logging

from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.contrib.auth.models import User

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helper: canonical room name (alphabetically sorted usernames)
# ---------------------------------------------------------------------------
def room_name_for(user_a: str, user_b: str) -> str:
    return '__'.join(sorted([user_a, user_b]))


def room_name_for_ids(user_a_id: int, user_b_id: int) -> str:
    lo, hi = sorted([int(user_a_id), int(user_b_id)])
    return f'{lo}__{hi}'


# ---------------------------------------------------------------------------
# 1. ChatConsumer
# ---------------------------------------------------------------------------
class ChatConsumer(AsyncWebsocketConsumer):
    """
    Handles real-time messaging.

    URL pattern: /ws/chat/<user_id>/
    Legacy fallback: /ws/chat/<username>/
    """

    # ---- Connection lifecycle ----------------------------------------------

    async def connect(self):
        if not self.scope['user'].is_authenticated:
            await self.close(code=4001)
            return

        self.me = self.scope['user']

        # Reject soft-deleted accounts
        if await self.is_account_deleted(self.me):
            await self.close(code=4002)
            return

        route_kwargs = self.scope.get('url_route', {}).get('kwargs', {})
        self.other_user = await self.resolve_other_user(route_kwargs)
        if not self.other_user:
            await self.close(code=4004)
            return

        if self.other_user.id == self.me.id:
            await self.close(code=4003)
            return

        self.other_user_id = self.other_user.id
        self.other_username = self.other_user.username
        self.room = room_name_for_ids(self.me.id, self.other_user_id)
        self.room_group = f'chat_{self.room}'

        # Join the room channel group and the global presence broadcast group
        await self.channel_layer.group_add(self.room_group, self.channel_name)
        await self.channel_layer.group_add('presence_all', self.channel_name)

        # Mark user active in DB
        await self.set_online(True)

        await self.accept()
        logger.info(f'[WS] {self.me.username} connected to room {self.room}')

        # Mark unread messages from the other user as delivered
        newly_delivered_ids = await self.mark_and_get_newly_delivered()
        for msg_id in newly_delivered_ids:
            await self.channel_layer.group_send(
                self.room_group,
                {
                    'type': 'broadcast_message_status',
                    'message_id': msg_id,
                    'status': 'delivered',
                }
            )

        # Broadcast Active status to ALL connected users via the global group
        await self.channel_layer.group_send(
            'presence_all',
            {
                'type': 'presence_update',
                'username': self.me.username,
                'status': 'active',
                'last_seen': None,
            }
        )

        # Immediately send the other user's current presence to this connection
        other_presence = await self.get_user_presence(self.other_user)
        await self.send(text_data=json.dumps({
            'type': 'presence',
            'username': self.other_username,
            'status': 'active' if other_presence['is_online'] else 'inactive',
            'last_seen': other_presence['last_seen'],
        }))

    async def disconnect(self, code):
        if hasattr(self, 'room_group'):
            await self.channel_layer.group_discard(self.room_group, self.channel_name)

        # Leave the global presence group
        await self.channel_layer.group_discard('presence_all', self.channel_name)

        if hasattr(self, 'me'):
            last_seen_iso = await self.set_online(False)
            # Broadcast Inactive status to ALL connected users via the global group
            await self.channel_layer.group_send(
                'presence_all',
                {
                    'type': 'presence_update',
                    'username': self.me.username,
                    'status': 'inactive',
                    'last_seen': last_seen_iso,
                }
            )

    # ---- Inbound messages --------------------------------------------------

    async def receive(self, text_data=None, bytes_data=None):
        try:
            data = json.loads(text_data)
        except (json.JSONDecodeError, TypeError):
            await self.send_error('Invalid JSON payload.')
            return

        msg_type = data.get('type')

        if msg_type == 'chat_message':
            await self.handle_chat_message(data)
        elif msg_type == 'file_notification':
            await self.handle_file_notification(data)
        elif msg_type == 'typing':
            await self.handle_typing(data)
        elif msg_type == 'delivered_receipt':
            await self.handle_delivered_receipt(data)
        elif msg_type == 'read_receipt':
            await self.handle_read_receipt(data)
        elif msg_type == 'ping':
            await self.send(text_data=json.dumps({'type': 'pong'}))
        else:
            await self.send_error(f'Unknown message type: {msg_type}')

    # ---- Chat message handler ----------------------------------------------

    async def handle_chat_message(self, data: dict):
        """
        Persists a message and broadcasts it to the room.
        """
        if 'message' not in data:
            await self.send_error('Missing field: message')
            return

        # Save to DB
        message = await self.save_message(data)
        if not message:
            await self.send_error('Failed to save message.')
            return

        payload = {
            'message_id': message['id'],
            'sender': self.me.username,
            'receiver': self.other_username,
            'receiver_id': self.other_user_id,
            'message': data.get('message', ''),
            'message_type': data.get('message_type', 'text'),
            'original_filename': data.get('original_filename', ''),
            'mime_type': data.get('mime_type', ''),
            'timestamp': message['timestamp'],
        }

        # Broadcast to the shared room group (both participants)
        await self.channel_layer.group_send(
            self.room_group,
            {'type': 'broadcast_message', **payload}
        )

    async def handle_file_notification(self, data: dict):
        """
        Broadcast a 'file upload complete' notification to the room.

        The file was already saved to the DB by the upload_file HTTP view.
        This handler just relays the metadata so the receiver's browser
        can render the file message bubble immediately.
        """
        required = ['message_id', 'file_id', 'message_type', 'original_filename']
        for field in required:
            if not data.get(field):
                await self.send_error(f'Missing file_notification field: {field}')
                return

        payload = {
            'message_id': data['message_id'],
            'file_id': data['file_id'],
            'sender': self.me.username,
            'receiver': self.other_username,
            'message_type': data['message_type'],
            'original_filename': data['original_filename'],
            'mime_type': data.get('mime_type', 'application/octet-stream'),
            'timestamp': data.get('timestamp', ''),
            'has_file': True,
        }

        await self.channel_layer.group_send(
            self.room_group,
            {'type': 'broadcast_file_notification', **payload},
        )

    async def handle_typing(self, data: dict):
        """Broadcasts typing indicator to the other party."""
        await self.channel_layer.group_send(
            self.room_group,
            {
                'type': 'broadcast_typing',
                'sender': self.me.username,
                'is_typing': bool(data.get('is_typing', False)),
            }
        )

    async def handle_delivered_receipt(self, data: dict):
        """Receiver notifies sender that a specific message was delivered."""
        message_id = data.get('message_id')
        if not message_id:
            return
        await self.mark_message_delivered(int(message_id))
        await self.channel_layer.group_send(
            self.room_group,
            {
                'type': 'broadcast_message_status',
                'message_id': int(message_id),
                'status': 'delivered',
            }
        )

    async def handle_read_receipt(self, data: dict):
        read_ids = await self.mark_messages_read_get_ids()
        for msg_id in read_ids:
            await self.channel_layer.group_send(
                self.room_group,
                {
                    'type': 'broadcast_message_status',
                    'message_id': msg_id,
                    'status': 'read',
                }
            )

    # ---- Group message handlers (outbound) ---------------------------------

    async def broadcast_message(self, event):
        payload = {k: v for k, v in event.items() if k != 'type'}
        payload['type'] = 'chat_message'
        await self.send(text_data=json.dumps(payload))

    async def broadcast_file_notification(self, event):
        payload = {k: v for k, v in event.items() if k != 'type'}
        payload['type'] = 'file_notification'
        await self.send(text_data=json.dumps(payload))

    async def broadcast_typing(self, event):
        await self.send(text_data=json.dumps({
            'type': 'typing',
            'sender': event['sender'],
            'is_typing': event['is_typing'],
        }))

    async def broadcast_message_status(self, event):
        """Relay message_status events (sent / delivered / read) to both clients."""
        await self.send(text_data=json.dumps({
            'type': 'message_status',
            'message_id': event['message_id'],
            'status': event['status'],
        }))

    async def presence_update(self, event):
        await self.send(text_data=json.dumps({
            'type': 'presence',
            'username': event['username'],
            'status': event.get('status', 'inactive'),
            'last_seen': event.get('last_seen'),
        }))

    async def message_removed(self, event):
        """Relay professional deletion events to connected clients."""
        await self.send(text_data=json.dumps({
            'type': 'message_removed',
            'message_id': event['message_id'],
            'removal_scope': event['removal_scope'],   # 'self' | 'all'
            'removed_by': event.get('removed_by', ''),
        }))

    async def chat_cleared(self, event):
        """Relay a chat_cleared event so both participants wipe their UI."""
        await self.send(text_data=json.dumps({
            'type': 'chat_cleared',
            'cleared_by': event['cleared_by'],
            'other_user': event['other_user'],
        }))

    # ---- Utilities ---------------------------------------------------------

    async def send_error(self, message: str):
        await self.send(text_data=json.dumps({'type': 'error', 'message': message}))

    # ---- DB helpers (sync wrapped) -----------------------------------------

    @database_sync_to_async
    def save_message(self, data: dict) -> dict | None:
        from .models import Message
        try:
            msg = Message.objects.create(
                sender=self.me,
                receiver=self.other_user,
                message=data.get('message', ''),
                message_type=data.get('message_type', Message.MESSAGE_TYPE_TEXT),
                original_filename=data.get('original_filename', ''),
                mime_type=data.get('mime_type', ''),
            )
            return {'id': msg.id, 'timestamp': msg.timestamp.isoformat()}
        except Exception as exc:
            logger.error(f'[WS] save_message error: {exc}')
            return None

    @database_sync_to_async
    def resolve_other_user(self, route_kwargs: dict):
        user_id = route_kwargs.get('user_id')
        username = route_kwargs.get('username')
        try:
            if user_id is not None:
                return User.objects.filter(id=int(user_id)).first()
            if username:
                return User.objects.filter(username=username).first()
        except (TypeError, ValueError):
            return None
        return None

    @database_sync_to_async
    def is_account_deleted(self, user) -> bool:
        """Returns True if the user's account has been soft-deleted."""
        from users.models import UserProfile
        try:
            return not user.profile.is_active_account
        except UserProfile.DoesNotExist:
            return False

    @database_sync_to_async
    def get_user_presence(self, user) -> dict:
        """Returns the current presence state for a given user."""
        from users.models import UserProfile
        try:
            profile = UserProfile.objects.get(user=user)
            return {
                'is_online': profile.is_online,
                'last_seen': profile.last_seen.isoformat() if profile.last_seen else None,
            }
        except UserProfile.DoesNotExist:
            return {'is_online': False, 'last_seen': None}
        except Exception as exc:
            logger.warning(f'[WS] get_user_presence error: {exc}')
            return {'is_online': False, 'last_seen': None}

    @database_sync_to_async
    def set_online(self, status: bool) -> str | None:
        """Sets is_online flag and returns last_seen ISO string when going offline."""
        from django.utils import timezone
        from users.models import UserProfile
        try:
            profile, _ = UserProfile.objects.get_or_create(user=self.me)
            profile.is_online = status
            profile.last_seen = timezone.now()
            profile.save(update_fields=['is_online', 'last_seen'])
            if not status:
                return profile.last_seen.isoformat()
        except Exception as exc:
            logger.warning(f'[WS] set_online error: {exc}')
        return None

    @database_sync_to_async
    def mark_message_delivered(self, message_id: int):
        from .models import Message
        try:
            Message.objects.filter(
                pk=message_id,
                receiver=self.me,
                is_delivered=False,
            ).update(is_delivered=True)
        except Exception as exc:
            logger.warning(f'[WS] mark_message_delivered error: {exc}')

    @database_sync_to_async
    def mark_and_get_newly_delivered(self) -> list:
        """Marks all undelivered messages sent to me from other_user as delivered.
        Returns the list of IDs that were just marked."""
        from .models import Message
        try:
            other = User.objects.filter(username=self.other_username).first()
            if not other:
                return []
            ids = list(
                Message.objects.filter(
                    sender=other,
                    receiver=self.me,
                    is_delivered=False,
                ).values_list('id', flat=True)
            )
            if ids:
                Message.objects.filter(pk__in=ids).update(is_delivered=True)
            return ids
        except Exception as exc:
            logger.warning(f'[WS] mark_and_get_newly_delivered error: {exc}')
            return []

    @database_sync_to_async
    def mark_messages_read_get_ids(self) -> list:
        """Marks all unread messages from other_user as read and returns their IDs."""
        from .models import Message
        try:
            other = User.objects.get(username=self.other_username)
            ids = list(
                Message.objects.filter(
                    sender=other,
                    receiver=self.me,
                    is_read=False,
                ).values_list('id', flat=True)
            )
            if ids:
                Message.objects.filter(pk__in=ids).update(is_delivered=True, is_read=True)
            return ids
        except Exception:
            return []


# ---------------------------------------------------------------------------
# 2. SignalingConsumer (WebRTC)
# ---------------------------------------------------------------------------
class SignalingConsumer(AsyncWebsocketConsumer):
    """
    Acts as the WebRTC signaling server.

    Each authenticated user joins their own personal group  ``user_<id>``.
    Incoming signals must carry a ``to_user`` field (username) so the server
    can route the payload to exactly the intended recipient's group.

    URL pattern: /ws/signal/<username>/
    (The <username> path parameter is accepted for routing compatibility but
    the group assignment is always based on the authenticated user's own ID.)
    """

    # ── Connection lifecycle ─────────────────────────────────────

    async def connect(self):
        if not self.scope['user'].is_authenticated:
            await self.close(code=4001)
            return

        self.me = self.scope['user']

        # Each user joins ONE personal inbox group based on their own ID.
        # This means ANY other user can send signals to them as long as they
        # know the target's username (resolved to ID server-side).
        self.user_group = f'user_{self.me.id}'

        await self.channel_layer.group_add(self.user_group, self.channel_name)
        await self.accept()
        logger.info(
            f'[Signal] {self.me.username} (id={self.me.id}) connected — '
            f'listening on group {self.user_group}'
        )

    async def disconnect(self, code):
        if hasattr(self, 'user_group'):
            await self.channel_layer.group_discard(self.user_group, self.channel_name)
        logger.info(f'[Signal] {getattr(self, "me", "?")} disconnected (code={code})')

    # ── Inbound frames from the browser ─────────────────────────

    async def receive(self, text_data=None, bytes_data=None):
        try:
            data = json.loads(text_data)
        except (json.JSONDecodeError, TypeError):
            return

        sig_type = data.get('type')
        allowed_types = {
            'offer', 'answer', 'ice-candidate',
            'call-request', 'call-accept', 'call-reject', 'call-end',
            'call-quality',
        }
        if sig_type not in allowed_types:
            return

        # Every signal frame MUST specify the intended recipient by username.
        to_username = data.get('to_user')
        if not to_username:
            logger.warning(
                f'[Signal] "{sig_type}" from {self.me.username} missing to_user — dropped'
            )
            return

        # Prevent relaying a signal back to the sender themselves
        if to_username == self.me.username:
            return

        target_user = await self._resolve_user(to_username)
        if not target_user:
            logger.warning(
                f'[Signal] Target user "{to_username}" not found — signal dropped'
            )
            return

        target_group = f'user_{target_user.id}'
        await self.channel_layer.group_send(
            target_group,
            {
                'type': 'signal_message',
                'from_user': self.me.username,
                'payload': data,
            }
        )

    # ── Outbound frame handler (channel layer → browser) ─────────

    async def signal_message(self, event):
        """Deliver a routed signal to the connected browser client."""
        payload = dict(event['payload'])
        # Stamp the sender's username so the browser knows who it came from
        payload['from'] = event['from_user']
        # Strip the routing field — it is irrelevant to the receiver
        payload.pop('to_user', None)
        await self.send(text_data=json.dumps(payload))

    # ── DB helper ────────────────────────────────────────────────

    @database_sync_to_async
    def _resolve_user(self, username: str):
        try:
            return User.objects.filter(username=username, is_active=True).first()
        except Exception as exc:
            logger.warning(f'[Signal] _resolve_user error: {exc}')
            return None
