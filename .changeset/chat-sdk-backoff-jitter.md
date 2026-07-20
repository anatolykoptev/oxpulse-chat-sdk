---
"@oxpulse/chat-sdk": patch
---
Add backoffWithJitter(attempt, schedule?, fallback?) as the default backoff with configurable schedule. backoffMs is now a thin wrapper delegating to backoffWithJitter (signature unchanged, backward compatible). Both already use ±20% jitter.
