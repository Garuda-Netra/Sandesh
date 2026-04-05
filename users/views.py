"""
Users Views

Landing page, Registration, Login, Logout, Profile management.
"""

import json

from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth import login, logout, alogin, alogout
from django.contrib.auth.decorators import login_required
from django.contrib.auth.models import User
from django.http import JsonResponse
from django.views.decorators.http import require_POST, require_GET
from django.contrib import messages
from django.views.decorators.csrf import csrf_protect
from django.utils import timezone
from asgiref.sync import sync_to_async

from .forms import SDHRegistrationForm, SDHLoginForm, ProfileUpdateForm
from .models import UserProfile


# ---------------------------------------------------------------------------
# Landing Page
# ---------------------------------------------------------------------------
def index(request):
    """
    Public landing page with OM particle animation.
    Redirects authenticated users directly to chat.
    """
    if request.user.is_authenticated:
        return redirect('messaging:chat')
    return render(request, 'index.html')


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------
@csrf_protect
def register_view(request):
    if request.user.is_authenticated:
        return redirect('messaging:chat')

    form = SDHRegistrationForm()

    if request.method == 'POST':
        form = SDHRegistrationForm(request.POST)
        if form.is_valid():
            user = form.save()
            messages.success(
                request,
                f'Account created successfully, {user.username}. Please sign in.'
            )
            return redirect('users:login')
        else:
            messages.error(request, 'Please fix the errors below.')

    return render(request, 'register.html', {'form': form})


# ---------------------------------------------------------------------------
# Login  (async — avoids CancelledError under Daphne caused by blocking
#          password-hash in a sync_to_async thread)
# ---------------------------------------------------------------------------
@csrf_protect
async def login_view(request):
    # request.user is a SimpleLazyObject that triggers a sync ORM call when
    # first accessed.  Under Daphne (ASGI) we must resolve it in a thread.
    is_authenticated = await sync_to_async(lambda: request.user.is_authenticated)()
    if is_authenticated:
        return redirect('messaging:chat')

    form = SDHLoginForm(request)

    if request.method == 'POST':
        form = SDHLoginForm(request, data=request.POST)
        # Run blocking authentication (password hash) in a thread
        is_valid = await sync_to_async(form.is_valid)()
        if is_valid:
            user = form.get_user()
            # Block soft-deleted accounts
            try:
                profile = await sync_to_async(lambda: user.profile)()
                if not profile.is_active_account:
                    messages.error(request, 'This account has been permanently deleted and is no longer accessible.')
                    return render(request, 'login.html', {'form': form})
            except UserProfile.DoesNotExist:
                pass
            await alogin(request, user)
            next_url = request.GET.get('next', 'messaging:chat')
            return redirect(next_url)
        else:
            messages.error(request, 'Invalid username or password.')

    return render(request, 'login.html', {'form': form})


# ---------------------------------------------------------------------------
# Logout  (sync — avoids SynchronousOnlyOperation from ORM/session access)
# ---------------------------------------------------------------------------
def logout_view(request):
    if request.user.is_authenticated:
        # Mark offline
        try:
            _mark_offline(request.user)
        except Exception:
            pass
    logout(request)
    return redirect('users:index')


def _mark_offline(user):
    """Sync helper: mark user offline in DB."""
    try:
        user.profile.is_online = False
        user.profile.save(update_fields=['is_online', 'last_seen'])
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_hidden_user_ids(user):
    """Return a queryset of User IDs that `user` has hidden from their list."""
    try:
        return user.profile.hidden_users.values_list('user_id', flat=True)
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Remove User from My List
# ---------------------------------------------------------------------------

@login_required
@require_POST
@csrf_protect
def remove_user_view(request):
    """
    POST /users/api/remove-user/

    Body: { "target_user_id": <int> }

    Adds the target user's profile to the current user's hidden_users list.
    Does NOT delete any account or messages.
    """
    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    target_user_id = body.get('target_user_id')
    if not target_user_id:
        return JsonResponse({'error': 'target_user_id is required'}, status=400)

    target_user = get_object_or_404(User, id=target_user_id)

    # Never allow hiding yourself
    if target_user.id == request.user.id:
        return JsonResponse({'error': 'Cannot remove yourself'}, status=400)

    try:
        my_profile = request.user.profile
    except UserProfile.DoesNotExist:
        return JsonResponse({'error': 'Your profile was not found'}, status=404)

    try:
        target_profile = target_user.profile
    except UserProfile.DoesNotExist:
        return JsonResponse({'error': 'Target profile not found'}, status=404)

    my_profile.hidden_users.add(target_profile)
    return JsonResponse({'status': 'removed', 'removed_user_id': target_user.id})


# ---------------------------------------------------------------------------
# User List API (for sidebar)
# ---------------------------------------------------------------------------
@login_required
@require_GET
def user_list(request):
    """Returns list of all active users except the current user and hidden ones."""
    hidden_ids = _get_hidden_user_ids(request.user)
    users = (
        User.objects
        .exclude(id=request.user.id)
        .exclude(id__in=hidden_ids)
        .filter(profile__is_active_account=True)
        .select_related('profile')
    )
    data = []
    for u in users:
        try:
            is_online = u.profile.is_online
        except UserProfile.DoesNotExist:
            is_online = False
        data.append({
            'username': u.username,
            'display_name': u.get_full_name() or u.username,
            'is_online': is_online,
        })
    return JsonResponse({'users': data})


# ---------------------------------------------------------------------------
# User Search API
# ---------------------------------------------------------------------------
@login_required
@require_GET
def search_users(request):
    """
    Live user search endpoint consumed by userSearch.js.

    GET /users/api/search-users/?q=<query>

    Returns up to 30 matching users (username icontains match),
    ordered by username, excluding the current user.
    Empty query returns the first 30 users (same behaviour as the sidebar).
    """
    q = request.GET.get('q', '').strip()

    hidden_ids = _get_hidden_user_ids(request.user)
    qs = (
        User.objects
        .exclude(id=request.user.id)
        .exclude(id__in=hidden_ids)
        .filter(profile__is_active_account=True)
        .select_related('profile')
    )
    if q:
        qs = qs.filter(username__icontains=q)
    qs = qs.order_by('username')[:30]

    data = []
    for u in qs:
        try:
            profile   = u.profile
            is_online = profile.is_online
            avatar_url = profile.avatar.url if profile.avatar else None
            last_seen  = (
                profile.last_seen.strftime('%b ') + str(profile.last_seen.day)
                if (not is_online and profile.last_seen)
                else None
            )
        except Exception:
            is_online  = False
            avatar_url = None
            last_seen  = None

        data.append({
            'id':         u.id,
            'username':   u.username,
            'is_online':  is_online,
            'avatar_url': avatar_url,
            'last_seen':  last_seen,
        })

    return JsonResponse({'users': data})


# ---------------------------------------------------------------------------
# Profile Page
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Account Deletion
# ---------------------------------------------------------------------------
@login_required
@csrf_protect
async def delete_account_view(request):
    """
    POST /account/delete/

    Soft-deletes the authenticated user's account:
      - Sets is_active_account = False and deleted_at = now
      - Marks the user offline
      - Logs the user out and invalidates their session
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'Method not allowed'}, status=405)

    user = request.user
    await sync_to_async(_soft_delete_account)(user)

    # Invalidate session and log out
    await alogout(request)

    return JsonResponse({'status': 'deleted'}, status=200)


def _soft_delete_account(user):
    """Sync helper: perform the soft-delete DB writes."""
    try:
        profile = user.profile
    except UserProfile.DoesNotExist:
        profile = UserProfile.objects.create(user=user)
    profile.is_active_account = False
    profile.deleted_at = timezone.now()
    profile.is_online = False
    profile.save(update_fields=['is_active_account', 'deleted_at', 'is_online', 'last_seen'])


# ---------------------------------------------------------------------------
# Profile Page
# ---------------------------------------------------------------------------
@login_required
def profile_view(request):
    profile, _ = UserProfile.objects.get_or_create(user=request.user)
    form = ProfileUpdateForm(instance=profile)

    if request.method == 'POST':
        form = ProfileUpdateForm(request.POST, request.FILES, instance=profile)
        if form.is_valid():
            form.save()
            messages.success(request, 'Profile updated successfully.')
            return redirect('users:profile')

    return render(request, 'users/profile.html', {'form': form, 'profile': profile})
