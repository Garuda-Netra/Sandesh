"""
Migration: add is_delivered to Message + performance indexes.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('messaging', '0003_message_file_message_file_name'),
    ]

    operations = [
        migrations.AddField(
            model_name='message',
            name='is_delivered',
            field=models.BooleanField(default=False),
        ),
        migrations.AddIndex(
            model_name='message',
            index=models.Index(fields=['receiver', 'is_delivered'], name='msg_rcv_delivered_idx'),
        ),
        migrations.AddIndex(
            model_name='message',
            index=models.Index(fields=['receiver', 'is_read'], name='msg_rcv_read_idx'),
        ),
    ]
