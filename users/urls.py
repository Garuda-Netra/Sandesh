"""
Users URL Configuration
"""

from django.urls import path
from . import views

app_name = 'users'

urlpatterns = [
    # Landing page (root URL)
    path('', views.index, name='index'),

    # Auth
    path('register/', views.register_view, name='register'),
    path('login/', views.login_view, name='login'),
    path('logout/', views.logout_view, name='logout'),

    # Profile
    path('profile/', views.profile_view, name='profile'),

    # Account deletion
    path('account/delete/', views.delete_account_view, name='delete_account'),

    # API endpoints
    path('api/users/', views.user_list, name='user_list'),
    path('api/search-users/', views.search_users, name='search_users'),
    path('api/remove-user/', views.remove_user_view, name='remove_user'),
]
