"""
Users App Configuration
"""

from django.apps import AppConfig


class UsersConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'users'
    verbose_name = 'Users'

    def ready(self):
        """
        Reset all stale is_online flags to False when the server starts.
        This prevents ghost-active users that remain marked online after
        an unclean shutdown or server restart.
        """
        try:
            from .models import UserProfile
            UserProfile.objects.filter(is_online=True).update(is_online=False)
        except Exception:
            # Database may not be ready on the very first migrate run.
            pass
