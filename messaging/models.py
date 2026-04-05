"""
Messaging Models

Message content is stored as plain text.
"""

from django.db import models
from django.contrib.auth.models import User
from django.utils import timezone


class Message(models.Model):
    """
    Stores a single message between two users.
    """
    MESSAGE_TYPE_TEXT = 'text'
    MESSAGE_TYPE_FILE = 'file'
    MESSAGE_TYPE_IMAGE = 'image'
    MESSAGE_TYPE_VIDEO = 'video'
    MESSAGE_TYPE_CALL = 'call'

    MESSAGE_TYPES = [
        (MESSAGE_TYPE_TEXT, 'Text'),
        (MESSAGE_TYPE_FILE, 'File'),
        (MESSAGE_TYPE_IMAGE, 'Image'),
        (MESSAGE_TYPE_VIDEO, 'Video'),
        (MESSAGE_TYPE_CALL, 'Call Log'),
    ]

    sender = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='sent_messages'
    )
    receiver = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='received_messages'
    )

    # Plain text message content
    message = models.TextField(
        blank=True,
        default='',
        help_text='Plain text message content'
    )

    # For files: original filename and MIME type
    original_filename = models.CharField(max_length=255, blank=True, default='')
    mime_type = models.CharField(max_length=100, blank=True, default='')

    # Uploaded file storage
    file = models.FileField(
        upload_to='files/',
        null=True,
        blank=True,
    )
    file_name = models.CharField(
        max_length=255,
        null=True,
        blank=True,
        help_text='Display name shown to users (original filename)'
    )

    message_type = models.CharField(
        max_length=10,
        choices=MESSAGE_TYPES,
        default=MESSAGE_TYPE_TEXT
    )

    timestamp = models.DateTimeField(auto_now_add=True, db_index=True)

    # Delivery / read tracking (updated via WebSocket signals)
    is_delivered = models.BooleanField(default=False)
    is_read = models.BooleanField(default=False)

    # Soft-delete: hide from both parties (legacy)
    deleted_by_sender = models.BooleanField(default=False)
    deleted_by_receiver = models.BooleanField(default=False)

    # Professional deletion: Remove from My View (per-user hidden list)
    hidden_for_users = models.ManyToManyField(
        User,
        blank=True,
        related_name='hidden_messages',
        help_text='Users for whom this message is hidden ("Remove from My View")',
    )

    # Professional deletion: Delete for All Participants
    is_deleted_for_all = models.BooleanField(
        default=False,
        help_text='True when sender deleted the message for all participants',
    )

    class Meta:
        ordering = ['timestamp']
        verbose_name = 'Message'
        verbose_name_plural = 'Messages'
        indexes = [
            models.Index(fields=['sender', 'receiver', 'timestamp']),
            models.Index(fields=['receiver', 'is_delivered']),
            models.Index(fields=['receiver', 'is_read']),
        ]

    def __str__(self):
        return (
            f'[{self.message_type}] {self.sender.username} → '
            f'{self.receiver.username} @ {self.timestamp:%Y-%m-%d %H:%M}'
        )


class CallLog(models.Model):
    """
    Records voice/video call events for display in the chat timeline.
    """
    CALL_VOICE = 'voice'
    CALL_VIDEO = 'video'
    CALL_TYPES = [
        (CALL_VOICE, 'Voice Call'),
        (CALL_VIDEO, 'Video Call'),
    ]

    STATUS_INITIATED = 'initiated'
    STATUS_ACCEPTED = 'accepted'
    STATUS_REJECTED = 'rejected'
    STATUS_MISSED = 'missed'
    STATUS_ENDED = 'ended'
    CALL_STATUSES = [
        (STATUS_INITIATED, 'Initiated'),
        (STATUS_ACCEPTED, 'Accepted'),
        (STATUS_REJECTED, 'Rejected'),
        (STATUS_MISSED, 'Missed'),
        (STATUS_ENDED, 'Ended'),
    ]

    caller = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name='initiated_calls'
    )
    callee = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name='received_calls'
    )
    call_type = models.CharField(max_length=10, choices=CALL_TYPES)
    status = models.CharField(
        max_length=15, choices=CALL_STATUSES, default=STATUS_INITIATED
    )
    started_at = models.DateTimeField(default=timezone.now)
    ended_at = models.DateTimeField(null=True, blank=True)

    @property
    def duration_seconds(self):
        if self.ended_at and self.started_at:
            return int((self.ended_at - self.started_at).total_seconds())
        return 0

    class Meta:
        ordering = ['-started_at']

    def __str__(self):
        return (
            f'{self.call_type.upper()} {self.caller.username} → '
            f'{self.callee.username} [{self.status}]'
        )
