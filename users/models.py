"""
Users Models

UserProfile extends Django's built-in User with:
  - Avatar support
  - Online status tracking
"""

from django.db import models
from django.contrib.auth.models import User
from django.db.models.signals import post_save
from django.dispatch import receiver
from django.utils import timezone


class UserProfile(models.Model):
    """
    Extended profile for each registered user.
    """
    user = models.OneToOneField(
        User,
        on_delete=models.CASCADE,
        related_name='profile'
    )

    created_at = models.DateTimeField(default=timezone.now, editable=False)

    avatar = models.ImageField(
        upload_to='avatars/',
        null=True,
        blank=True
    )

    # Simple online indicator — updated via WebSocket connect/disconnect
    is_online = models.BooleanField(default=False)

    last_seen = models.DateTimeField(auto_now=True)

    bio = models.CharField(max_length=200, blank=True, default='')

    # ── Hidden / removed contacts (one-way) ────────────────────────────────
    hidden_users = models.ManyToManyField(
        'self',
        symmetrical=False,
        blank=True,
        related_name='hidden_by',
        help_text="Profiles hidden from this user's contact list."
    )

    # ── Soft-delete fields ──────────────────────────────────────────────────
    is_active_account = models.BooleanField(
        default=True,
        help_text='False = account soft-deleted by owner.'
    )
    deleted_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text='Timestamp when the account was soft-deleted.'
    )

    class Meta:
        verbose_name = 'User Profile'
        verbose_name_plural = 'User Profiles'

    def __str__(self):
        return f'Profile of {self.user.username}'

    @property
    def display_name(self):
        return self.user.get_full_name() or self.user.username




# ---------------------------------------------------------------------------
# Signal: Auto-create UserProfile when a new User is created
# ---------------------------------------------------------------------------
@receiver(post_save, sender=User)
def create_user_profile(sender, instance, created, **kwargs):
    if created:
        UserProfile.objects.get_or_create(user=instance)


@receiver(post_save, sender=User)
def save_user_profile(sender, instance, **kwargs):
    if hasattr(instance, 'profile'):
        instance.profile.save()
