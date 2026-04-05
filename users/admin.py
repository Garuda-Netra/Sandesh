"""
Users Admin Registration
"""

from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.contrib.auth.models import User
from .models import UserProfile


class UserProfileInline(admin.StackedInline):
    model = UserProfile
    can_delete = False
    verbose_name_plural = 'Profile'
    fields = ('is_online', 'bio', 'avatar', 'last_seen')
    readonly_fields = ('last_seen',)


class UserAdmin(BaseUserAdmin):
    inlines = (UserProfileInline,)
    list_display = ('username', 'email', 'date_joined', 'is_staff', 'profile_online')

    def profile_online(self, obj):
        try:
            return obj.profile.is_online
        except Exception:
            return False
    profile_online.boolean = True
    profile_online.short_description = 'Online'


# Re-register UserAdmin
admin.site.unregister(User)
admin.site.register(User, UserAdmin)
admin.site.register(UserProfile)
