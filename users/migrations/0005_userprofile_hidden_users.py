"""
Migration: add hidden_users M2M field to UserProfile.

Allows any user to hide another user from their own contact list
without deleting any account or messages.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('users', '0004_userprofile_deleted_at_userprofile_is_active_account'),
    ]

    operations = [
        migrations.AddField(
            model_name='userprofile',
            name='hidden_users',
            field=models.ManyToManyField(
                blank=True,
                help_text="Profiles hidden from this user's contact list.",
                related_name='hidden_by',
                symmetrical=False,
                to='users.userprofile',
            ),
        ),
    ]
