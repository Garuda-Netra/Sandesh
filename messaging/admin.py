"""
Messaging Admin
"""

from django.contrib import admin
from .models import Message, CallLog


@admin.register(Message)
class MessageAdmin(admin.ModelAdmin):
    list_display = ('sender', 'receiver', 'message_type', 'timestamp', 'is_read')
    list_filter = ('message_type', 'is_read', 'timestamp')
    search_fields = ('sender__username', 'receiver__username')
    readonly_fields = ('message', 'timestamp')
    ordering = ('-timestamp',)

    def has_change_permission(self, request, obj=None):
        return False


@admin.register(CallLog)
class CallLogAdmin(admin.ModelAdmin):
    list_display = ('caller', 'callee', 'call_type', 'status', 'started_at', 'duration_seconds')
    list_filter = ('call_type', 'status')
    search_fields = ('caller__username', 'callee__username')
    readonly_fields = ('started_at',)
