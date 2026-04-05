"""
Remove the public_key field from UserProfile.

Chat messages are stored and transmitted as plain text.
No E2E encryption key infrastructure is needed.
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('users', '0002_userprofile_created_at'),
    ]

    operations = [
        migrations.RemoveField(
            model_name='userprofile',
            name='public_key',
        ),
    ]
