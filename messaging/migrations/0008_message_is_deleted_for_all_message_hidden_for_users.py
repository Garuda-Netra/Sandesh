# Generated migration — professional deletion fields

from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('messaging', '0007_remove_message_encryption_fields'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name='message',
            name='is_deleted_for_all',
            field=models.BooleanField(
                default=False,
                help_text='True when sender deleted the message for all participants',
            ),
        ),
        migrations.AddField(
            model_name='message',
            name='hidden_for_users',
            field=models.ManyToManyField(
                blank=True,
                help_text='Users for whom this message is hidden ("Remove from My View")',
                related_name='hidden_messages',
                to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]
