# Calling v2 session layer

Calling v2 is the authoritative server-side lifecycle for one-to-one Pulse
calls. WebRTC media remains peer-to-peer; Railway only relays ephemeral signaling.

## Rollout guard

`PULSE_CALLING_V2_ENABLED` defaults to `false`. When disabled, the Socket.IO
handlers are not registered. Do not enable it in Railway until the native
audio client is ready for an end-to-end test.

## Socket contract

- `call:v2:start`: `{ requestId, calleeUid, mediaType }`
- `call:v2:command`: `{ sessionId, eventId, expectedRevision, command, reason? }`
- `call:v2:snapshot`: `{ sessionId }`
- `call:v2:updated`: authoritative session snapshot sent to both participants
- `call:v2:ice-config`: returns short-lived Cloudflare STUN/TURN configuration
- `call:v2:media`: relays an SDP offer, SDP answer or ICE candidate to the peer
  after the call reaches `CONNECTING`

Every request uses a Socket.IO acknowledgement containing `ok`, `status` and,
when available, `session`. A stale `expectedRevision` returns `CONFLICT` with
the latest snapshot. Retrying the same `requestId` or `eventId` is idempotent.

## Authoritative states

`PREPARING -> RINGING -> CONNECTING -> ACTIVE -> ENDED`

Only the caller can mark an invite ready. Only the callee can accept or
decline. Both clients must report `MEDIA_CONNECTED` before the session becomes
active. `NETWORK_LOST` returns the session to connecting so a future client can
perform an ICE restart.

## Redis ownership

- `pulse:calling:v2:session:<sessionId>` stores the snapshot.
- `pulse:calling:v2:user:<uid>` is the per-user active-call lease.
- `pulse:calling:v2:request:<callerUid>:<requestId>` deduplicates starts.
- `pulse:calling:v2:event:<sessionId>:<eventId>` deduplicates commands.

Creation and transitions use Lua scripts so leases, revisions and snapshots
change atomically across Railway instances. Live sessions and request keys
expire after two hours. Ended snapshots expire after five minutes and release
both user leases immediately. The service fails closed when Redis is absent.

## Security boundaries

The server derives the caller from the authenticated socket. The callee must be
an allowed contact and neither participant may have blocked the other. Session
snapshots are available only to participants. The protocol stores no SDP, ICE
candidates, media, tokens or TURN credentials. SDP and candidates are validated,
size-limited and relayed without logging. Clients deduplicate `messageId` values.
Only the caller can send an offer and only the callee can send an answer.

Cloudflare's long-lived TURN key id and secret stay in Railway as
`CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_KEY_SECRET`. The server exchanges
them for short-lived credentials only after participant and session-state checks.
TURN provides network relay only and never controls call state. Port 53 relay
URLs are discarded because Cloudflare documents them as an emergency fallback.
