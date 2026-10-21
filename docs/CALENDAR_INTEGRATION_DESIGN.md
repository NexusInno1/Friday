# Google Calendar Integration Architecture Design

This document details the architectural and security design for integrating Google Calendar (read-only) into FRIDAY.

---

## 1. Problem Statement & Objectives

Currently, FRIDAY's morning intelligence briefing includes a reminders section with the disclaimer:
```
📋 Reminders: Calendar not connected, agenda unknown beyond scheduled reminders
```
To eliminate this blind spot and provide a true executive briefing, FRIDAY needs read-only visibility into the user's primary Google Calendar to:
1. Summarize scheduled meetings, agendas, and video call links (Google Meet, Zoom) for the day.
2. Cross-reference upcoming meetings with reminders to alert the user about scheduling conflicts or preparation needs.
3. Respect strict security boundaries: read-only permissions, encrypted token storage, and zero write/delete capability.

---

## 2. Security Boundaries & OAuth Scopes

### 2.1 Principle of Least Privilege
FRIDAY strictly requests only read-only access to calendar events:
- **Scope**: `https://www.googleapis.com/auth/calendar.readonly`
- **Forbidden Scopes**: No `calendar`, `calendar.events`, or write permissions. FRIDAY will never create, reschedule, or delete events on the user's calendar.

### 2.2 Token Encryption & Storage
- Tokens (`access_token`, `refresh_token`, and token expiry) must never be stored in plaintext.
- **Storage**: Stored in Supabase in a new table `user_oauth_credentials`:
  ```sql
  CREATE TABLE IF NOT EXISTS user_oauth_credentials (
    user_id BIGINT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('google_calendar')),
    encrypted_access_token TEXT NOT NULL,
    encrypted_refresh_token TEXT NOT NULL,
    token_expiry TIMESTAMPTZ NOT NULL,
    scope TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE user_oauth_credentials ENABLE ROW LEVEL SECURITY;
  ```
- **Encryption**: AES-256-GCM encryption with an authentication tag, keyed by a 256-bit environment secret (`ENCRYPTION_KEY` or `TOKEN_ENCRYPTION_SECRET`), using unique 12-byte initialization vectors (IVs) per encryption operation.

---

## 3. Authentication & Authorization Flow

```
[ Telegram User ]                  [ FRIDAY Bot ]                   [ Google OAuth 2.0 ]
       |                                  |                                  |
       | 1. /connect_calendar             |                                  |
       |--------------------------------->|                                  |
       |                                  | 2. Generate cryptographically    |
       |                                  |    secure state (HMAC + TTL)     |
       | 3. Reply with Auth URL           |                                  |
       |<---------------------------------|                                  |
       |                                  |                                  |
       | 4. User opens Auth URL & approves in browser                        |
       |-------------------------------------------------------------------->|
       |                                  |                                  |
       |                                  | 5. Callback with ?code=&state=   |
       |                                  |<---------------------------------|
       |                                  | 6. Exchange code for tokens      |
       |                                  |--------------------------------->|
       |                                  | 7. Return access & refresh token |
       |                                  |<---------------------------------|
       |                                  | 8. Encrypt & persist tokens      |
       | 9. "✅ Calendar connected!"      |                                  |
       |<---------------------------------|                                  |
```

### 3.1 Telegram Command & State Validation
1. User sends `/connect_calendar` to FRIDAY in private Telegram chat.
2. FRIDAY verifies that `user.id === env().TELEGRAM_ALLOWED_USER_ID`.
3. FRIDAY generates a state token containing `{ userId, timestamp, signature }` valid for 10 minutes.
4. FRIDAY replies with an inline button or link directing to Google's OAuth consent screen:
   `https://accounts.google.com/o/oauth2/v2/auth?client_id=...&redirect_uri=...&response_type=code&scope=https://www.googleapis.com/auth/calendar.readonly&access_type=offline&prompt=consent&state=...`

### 3.2 OAuth Webhook Callback Endpoint
1. FRIDAY's Express health/webhook server exposes `GET /auth/google/callback`.
2. Verifies the `state` parameter HMAC and timestamp to prevent CSRF.
3. Exchanges the authorization `code` with Google's token endpoint (`https://oauth2.googleapis.com/token`).
4. Encrypts tokens and persists them in `user_oauth_credentials`.
5. Sends a Telegram confirmation message: `"✅ Google Calendar connected successfully! Your morning briefings will now include your daily schedule."`

---

## 4. Token Refresh & Lifecycle Management

Google access tokens expire in 3600 seconds (1 hour). Before every calendar read operation:
1. Check `token_expiry`.
2. If `token_expiry - Date.now() < 300_000` (5 minutes buffer):
   - Request a new `access_token` using the encrypted `refresh_token`.
   - Update `encrypted_access_token` and `token_expiry` in the database.
3. If the refresh request returns `invalid_grant` (e.g. user revoked access via Google Account settings):
   - Mark credentials as revoked.
   - Dispatch a Telegram notification: `"⚠️ Google Calendar authorization has expired or was revoked. Use /connect_calendar to re-link your calendar."`

---

## 5. Agent Tool Interface: `get_calendar_events`

The assistant engine and scheduler will be equipped with a scoped tool:

```typescript
export const getCalendarEventsTool = tool({
  description:
    "Retrieve scheduled calendar events and meetings for a given date or range. " +
    "Use when planning the day, checking availability, or verifying meeting times.",
  parameters: z.object({
    date: z.string().describe("ISO date (YYYY-MM-DD) to fetch events for (defaults to today)"),
    timeZone: z.string().optional().describe("User timezone, e.g. 'Asia/Kolkata'"),
  }),
  execute: async ({ date, timeZone }) => {
    // 1. Decrypt credentials & refresh token if needed
    // 2. Call Google Calendar API v3: events.list
    // 3. Filter out cancelled events and private placeholders
    // 4. Return structured summary: summary, start, end, location, meetUrl, attendees
  },
});
```

---

## 6. Morning Intelligence Briefing Integration

In `src/services/scheduler.service.ts`:
1. During `sendDailyBriefing`:
   - Attempt to fetch today's calendar events via `fetchTodayCalendarEvents(userId, USER_TIMEZONE)`.
2. If calendar is connected and events exist:
   ```markdown
   📅 **Today's Agenda & Schedule (3 events):**
     • 10:00 AM - 10:45 AM — Sprint Planning (Google Meet: meet.google.com/xyz)
     • 02:00 PM - 02:30 PM — 1:1 with Alex
     • 04:30 PM - 05:00 PM — Architecture Review

   📋 **Scheduled Reminders (1):**
     • 09:30 AM — Review deployment checklist
   ```
3. If calendar is connected but no events are scheduled:
   ```markdown
   📅 **Today's Agenda:** Clear calendar today. No meetings scheduled.
   ```
4. If calendar is not connected:
   ```markdown
   📋 **Reminders:**
     • 09:30 AM — Review deployment checklist
   (Calendar not connected. Use /connect_calendar to include your Google Calendar agenda)
   ```

---

## 7. Configuration Variables to Add

```env
# Google Calendar OAuth 2.0 (Optional)
GOOGLE_OAUTH_CLIENT_ID="[CLIENT_ID].apps.googleusercontent.com"
GOOGLE_OAUTH_CLIENT_SECRET="GOCSPX-..."
GOOGLE_OAUTH_REDIRECT_URI="https://friday.railway.app/auth/google/callback"
TOKEN_ENCRYPTION_KEY="[64-character-hex-string-for-aes-256]"
```

---

## 8. Rollout Plan

1. **Phase 1**: Land design doc (this document) and schema migrations (`user_oauth_credentials`).
2. **Phase 2**: Implement OAuth redirect & callback handler in `src/services/calendar-auth.service.ts`.
3. **Phase 3**: Implement calendar API fetcher with automatic refresh in `src/services/calendar.service.ts`.
4. **Phase 4**: Wire into `createTools` (`get_calendar_events`) and `sendDailyBriefing`.
