"""
Messaging Views

Main chat interface and message history API.
"""

import json
import os
import mimetypes

from django.shortcuts import render, get_object_or_404
from django.contrib.auth.decorators import login_required
from django.contrib.auth.models import User
from django.http import JsonResponse, FileResponse, Http404
from django.views.decorators.http import require_GET, require_POST
from django.views.decorators.csrf import csrf_protect
from django.db.models import Q
from django.utils import timezone
from django.conf import settings

from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

from .models import Message, CallLog
from users.models import UserProfile

# Maximum file size accepted (20 MB)
_MAX_FILE_BYTES = 20 * 1024 * 1024

# Allowed upload MIME types (broad but bounded)
_ALLOWED_MIME_PREFIXES = ('image/', 'video/', 'audio/')
_ALLOWED_MIME_TYPES = {
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
}


# ---------------------------------------------------------------------------
# Chat Page
# ---------------------------------------------------------------------------
@login_required
def chat_view(request):
    """
    Main chat interface.
    Loads the shell; real-time messages flow via WebSocket.
    """
    # Users hidden by the current user should not appear in their list
    try:
        hidden_profile_ids = request.user.profile.hidden_users.values_list('user_id', flat=True)
    except Exception:
        hidden_profile_ids = []

    users = (
        User.objects
        .exclude(id=request.user.id)
        .exclude(id__in=hidden_profile_ids)
        .filter(profile__is_active_account=True)
        .select_related('profile')
        .order_by('username')
    )

    # Build user list with online status and last_seen
    user_data = []
    for u in users:
        try:
            profile = u.profile
            is_online = profile.is_online
            last_seen = profile.last_seen  # datetime object for template filters
        except UserProfile.DoesNotExist:
            is_online = False
            last_seen = None
        user_data.append({
            'user': u,
            'is_online': is_online,
            'last_seen': last_seen,
        })

    # Put online users first
    user_data.sort(key=lambda x: (not x['is_online'], x['user'].username.lower()))

    context = {
        'users': user_data,
        'current_user': request.user,
    }
    return render(request, 'messaging/chat.html', context)


# ---------------------------------------------------------------------------
# Message History API
# ---------------------------------------------------------------------------
@login_required
@require_GET
def message_history(request, username):
    """
    Returns paginated message history between
    the current user and the named user.
    """
    other_user = get_object_or_404(User, username=username)
    page = int(request.GET.get('page', 1))
    per_page = int(request.GET.get('per_page', 50))

    messages_qs = (
        Message.objects
        .filter(
            (Q(sender=request.user) & Q(receiver=other_user)) |
            (Q(sender=other_user) & Q(receiver=request.user))
        )
        .exclude(
            Q(sender=request.user, deleted_by_sender=True) |
            Q(receiver=request.user, deleted_by_receiver=True)
        )
        # "Remove from My View" — hide only for the requesting user
        .exclude(hidden_for_users=request.user)
        .order_by('-timestamp')
    )

    total = messages_qs.count()
    start = (page - 1) * per_page
    end = start + per_page
    messages_page = list(reversed(messages_qs[start:end]))

    # Mark unread messages as read
    Message.objects.filter(
        sender=other_user,
        receiver=request.user,
        is_read=False
    ).update(is_read=True)

    def _display_name(u):
        """Return username; append '(Account Deleted)' for soft-deleted accounts."""
        try:
            if not u.profile.is_active_account:
                return f'{u.username} (Account Deleted)'
        except Exception:
            pass
        return u.username

    data = [
        {
            'id': m.id,
            'sender': _display_name(m.sender),
            'receiver': _display_name(m.receiver),
            'message': m.message,
            'message_type': m.message_type,
            'original_filename': m.original_filename or m.file_name or '',
            'mime_type': m.mime_type,
            'timestamp': m.timestamp.isoformat(),
            'is_delivered': m.is_delivered,
            'is_read': m.is_read,
            'is_mine': m.sender == request.user,
            'has_file': bool(m.file),
            'file_id': m.id if m.file else None,
            'is_deleted_for_all': m.is_deleted_for_all,
        }
        for m in messages_page
    ]

    return JsonResponse({
        'messages': data,
        'total': total,
        'page': page,
        'has_more': end < total,
    })


# ---------------------------------------------------------------------------
# Save Message (REST fallback — primary path is via WebSocket)
# ---------------------------------------------------------------------------
@login_required
@require_POST
def save_message(request):
    """
    REST fallback for saving a message.
    Primary message saving happens inside the WebSocket consumer.
    """
    try:
        data = json.loads(request.body)
        receiver_username = data.get('receiver')
        message           = data.get('message', '')
        message_type      = data.get('message_type', Message.MESSAGE_TYPE_TEXT)
        original_filename = data.get('original_filename', '')
        mime_type         = data.get('mime_type', '')

        if not receiver_username:
            return JsonResponse({'error': 'Missing required fields.'}, status=400)

        receiver = get_object_or_404(User, username=receiver_username)

        msg = Message.objects.create(
            sender=request.user,
            receiver=receiver,
            message=message,
            message_type=message_type,
            original_filename=original_filename,
            mime_type=mime_type,
        )

        return JsonResponse({
            'status': 'ok',
            'message_id': msg.id,
            'timestamp': msg.timestamp.isoformat(),
        })

    except Exception as exc:
        return JsonResponse({'error': str(exc)}, status=500)


# ---------------------------------------------------------------------------
# Unread Count API
# ---------------------------------------------------------------------------
@login_required
@require_GET
def unread_counts(request):
    """Returns unread message counts grouped by sender."""
    from django.db.models import Count
    counts = (
        Message.objects
        .filter(receiver=request.user, is_read=False)
        .values('sender__username')
        .annotate(count=Count('id'))
    )
    data = {item['sender__username']: item['count'] for item in counts}
    return JsonResponse({'unread': data})


# ---------------------------------------------------------------------------
# File Upload
# ---------------------------------------------------------------------------
@login_required
@csrf_protect
@require_POST
def upload_file(request):
    """
    Accept a file from the browser and save it to the server.

    Expected multipart/form-data fields:
        file          – file binary
        file_name     – original filename
        receiver      – recipient username
        mime_type     – MIME type of the file
        message_type  – 'file' | 'image' | 'video'

    Returns JSON: { message_id, file_id, timestamp }
    """
    uploaded = request.FILES.get('file')
    if not uploaded:
        return JsonResponse({'error': 'No file provided.'}, status=400)

    # ── Size guard ──────────────────────────────────────────────
    if uploaded.size > _MAX_FILE_BYTES:
        return JsonResponse(
            {'error': f'File exceeds the 20 MB limit ({uploaded.size} bytes).'},
            status=413,
        )

    # ── Required metadata ───────────────────────────────────────
    receiver_username = request.POST.get('receiver', '').strip()
    file_name         = request.POST.get('file_name', uploaded.name).strip()
    mime_type         = request.POST.get('mime_type', 'application/octet-stream').strip()
    message_type      = request.POST.get('message_type', Message.MESSAGE_TYPE_FILE).strip()

    if not receiver_username:
        return JsonResponse({'error': 'Missing required fields.'}, status=400)

    if message_type not in ('file', 'image', 'video'):
        message_type = Message.MESSAGE_TYPE_FILE

    # ── Resolve receiver ────────────────────────────────────────
    receiver = get_object_or_404(User, username=receiver_username)
    if receiver == request.user:
        return JsonResponse({'error': 'Cannot send file to yourself.'}, status=400)

    # ── Persist Message ─────────────────────────────────────────
    msg = Message.objects.create(
        sender=request.user,
        receiver=receiver,
        message='',
        message_type=message_type,
        original_filename=file_name,
        file_name=file_name,
        mime_type=mime_type,
        file=uploaded,
    )

    return JsonResponse({
        'status': 'ok',
        'message_id': msg.id,
        'file_id': msg.id,
        'sender': request.user.username,
        'receiver': receiver_username,
        'message_type': msg.message_type,
        'original_filename': msg.file_name,
        'mime_type': msg.mime_type,
        'timestamp': msg.timestamp.isoformat(),
        'has_file': True,
    }, status=201)


# ---------------------------------------------------------------------------
# File Download
# ---------------------------------------------------------------------------
@login_required
@require_GET
def download_file(request, file_id):
    """
    Stream a file back to an authorised participant.

    Only the sender and receiver of the message may download.
    """
    msg = get_object_or_404(
        Message,
        pk=file_id,
        message_type__in=(
            Message.MESSAGE_TYPE_FILE,
            Message.MESSAGE_TYPE_IMAGE,
            Message.MESSAGE_TYPE_VIDEO,
        ),
    )

    # ── Authorisation: only sender or receiver ──────────────────
    if request.user not in (msg.sender, msg.receiver):
        raise Http404('File not found.')

    if not msg.file:
        return JsonResponse({'error': 'No file stored for this message.'}, status=404)

    # ── Stream file ─────────────────────────────────────────────
    try:
        file_handle = msg.file.open('rb')
    except FileNotFoundError:
        return JsonResponse({'error': 'File data missing on server.'}, status=404)

    # Use the stored MIME type for the Content-Type header.
    content_type = msg.mime_type or 'application/octet-stream'

    response = FileResponse(
        file_handle,
        content_type='application/octet-stream',
        as_attachment=False,
    )
    response['Content-Disposition'] = (
        f'attachment; filename="{os.path.basename(msg.file.name)}"'
    )
    response['X-SDH-Original-Mime'] = content_type
    response['X-SDH-File-Name']     = msg.file_name or msg.original_filename or 'sdh_file'
    response['Access-Control-Expose-Headers'] = (
        'X-SDH-Original-Mime, X-SDH-File-Name'
    )
    return response


# ---------------------------------------------------------------------------
# Remove from My View
# ---------------------------------------------------------------------------
@login_required
@require_POST
def remove_from_my_view(request, message_id):
    """
    Adds the current user to hidden_for_users.
    The message record is preserved; only this user stops seeing it.
    """
    msg = get_object_or_404(Message, pk=message_id)

    # Only sender or receiver may act
    if request.user not in (msg.sender, msg.receiver):
        return JsonResponse({'error': 'Not authorised.'}, status=403)

    msg.hidden_for_users.add(request.user)

    # Notify the requesting client via WebSocket so the UI can react
    lo, hi = sorted([msg.sender_id, msg.receiver_id])
    room_group = f'chat_{lo}__{hi}'
    try:
        async_to_sync(get_channel_layer().group_send)(
            room_group,
            {
                'type': 'message_removed',
                'message_id': message_id,
                'removal_scope': 'self',
                'removed_by': request.user.username,
            },
        )
    except Exception:
        pass  # channel layer may not be available in all environments

    return JsonResponse({'status': 'ok'})


# ---------------------------------------------------------------------------
# Delete for All Participants
# ---------------------------------------------------------------------------
@login_required
@require_POST
def delete_for_all(request, message_id):
    """
    Permanently removes message content for all participants.
    Only the original sender may invoke this action.
    Associated file is deleted from storage to prevent orphan files.
    """
    msg = get_object_or_404(Message, pk=message_id)

    if msg.sender != request.user:
        return JsonResponse(
            {'error': 'Only the original sender can delete a message for all participants.'},
            status=403,
        )

    # Delete file from storage and clear references
    if msg.file:
        try:
            file_path = msg.file.path
            if os.path.isfile(file_path):
                os.remove(file_path)
        except Exception:
            pass  # log in production; do not halt the operation
        msg.file = None
        msg.file_name = ''
        msg.original_filename = ''

    # Replace content with professional placeholder
    msg.message = 'This message has been deleted.'
    msg.message_type = Message.MESSAGE_TYPE_TEXT
    msg.is_deleted_for_all = True
    msg.save(update_fields=[
        'message', 'message_type', 'is_deleted_for_all',
        'file', 'file_name', 'original_filename',
    ])

    # Broadcast real-time update to all participants in this chat room
    lo, hi = sorted([msg.sender_id, msg.receiver_id])
    room_group = f'chat_{lo}__{hi}'
    try:
        async_to_sync(get_channel_layer().group_send)(
            room_group,
            {
                'type': 'message_removed',
                'message_id': message_id,
                'removal_scope': 'all',
                'removed_by': request.user.username,
            },
        )
    except Exception:
        pass

    return JsonResponse({'status': 'ok'})


# ---------------------------------------------------------------------------
# Clear All Chat
# ---------------------------------------------------------------------------
@login_required
@require_POST
def clear_chat(request, username):
    """
    Hard-deletes every message exchanged between request.user and the given user.
    Files stored on disk are removed before the DB rows are deleted.
    A real-time broadcast tells both participants to wipe their chat UI.
    """
    other_user = get_object_or_404(User, username=username)

    messages_qs = Message.objects.filter(
        Q(sender=request.user, receiver=other_user) |
        Q(sender=other_user, receiver=request.user)
    )

    # Delete files from storage to prevent orphan media
    for msg in messages_qs.exclude(file='').exclude(file=None):
        try:
            file_path = msg.file.path
            if os.path.isfile(file_path):
                os.remove(file_path)
        except Exception:
            pass  # log in production; do not halt the operation

    deleted_count, _ = messages_qs.delete()

    # Broadcast real-time clear event to both users in the shared chat room
    lo, hi = sorted([request.user.id, other_user.id])
    room_group = f'chat_{lo}__{hi}'
    try:
        async_to_sync(get_channel_layer().group_send)(
            room_group,
            {
                'type': 'chat_cleared',
                'cleared_by': request.user.username,
                'other_user': other_user.username,
            },
        )
    except Exception:
        pass

    return JsonResponse({'status': 'ok', 'deleted': deleted_count})


# ---------------------------------------------------------------------------
# Call Page
# ---------------------------------------------------------------------------
@login_required
def call_view(request, username=None):
    """
    Dedicated full-page WebRTC call interface.

    Loads the contact list so the user can initiate or receive calls.
    An optional `username` URL segment pre-selects the remote user.
    """
    users = (
        User.objects
        .exclude(id=request.user.id)
        .select_related('profile')
        .order_by('username')
    )

    user_data = []
    for u in users:
        try:
            is_online = u.profile.is_online
        except UserProfile.DoesNotExist:
            is_online = False
        user_data.append({
            'user': u,
            'is_online': is_online,
        })

    context = {
        'users': user_data,
        'current_user': request.user,
        'preselect_username': username or '',
    }
    return render(request, 'messaging/call.html', context)
