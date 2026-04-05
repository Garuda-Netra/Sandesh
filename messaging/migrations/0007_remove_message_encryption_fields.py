"""
Remove E2E encryption fields from the Message model and add a plain
text `message` field.

Removes: encrypted_message, encrypted_key, sender_encrypted_key, iv
Adds:    message (TextField, blank=True, default='')
Updates: file upload_to from 'encrypted_files/' to 'files/'
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('messaging', '0006_message_sender_encrypted_key'),
    ]

    operations = [
        # Add the plain message field
        migrations.AddField(
            model_name='message',
            name='message',
            field=models.TextField(
                blank=True,
                default='',
                help_text='Plain text message content',
            ),
        ),

        # Remove encryption fields
        migrations.RemoveField(
            model_name='message',
            name='encrypted_message',
        ),
        migrations.RemoveField(
            model_name='message',
            name='encrypted_key',
        ),
        migrations.RemoveField(
            model_name='message',
            name='sender_encrypted_key',
        ),
        migrations.RemoveField(
            model_name='message',
            name='iv',
        ),

        # Update file upload path
        migrations.AlterField(
            model_name='message',
            name='file',
            field=models.FileField(
                blank=True,
                null=True,
                upload_to='files/',
            ),
        ),
    ]
