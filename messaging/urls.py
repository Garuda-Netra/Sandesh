"""
Messaging URL Configuration
"""

from django.urls import path
from . import views

app_name = 'messaging'

urlpatterns = [
    path('chat/', views.chat_view, name='chat'),
    path('call/', views.call_view, name='call'),
    path('call/<str:username>/', views.call_view, name='call_with_user'),
    path('api/history/<str:username>/', views.message_history, name='message_history'),
    path('api/save/', views.save_message, name='save_message'),
    path('api/unread/', views.unread_counts, name='unread_counts'),
    # Secure file transfer
    path('upload-file/', views.upload_file, name='upload_file'),
    path('download-file/<int:file_id>/', views.download_file, name='download_file'),
    # Professional message deletion
    path('api/message/<int:message_id>/remove-my-view/', views.remove_from_my_view, name='remove_from_my_view'),
    path('api/message/<int:message_id>/delete-for-all/', views.delete_for_all, name='delete_for_all'),
    # Clear all chat history
    path('api/clear-chat/<str:username>/', views.clear_chat, name='clear_chat'),
]
