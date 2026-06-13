# SDK ↔ Server Contract Notes

## `visibility` field — listRooms vs createRoom/getRoom

The server exposes two shapes for room data:

| Endpoint | Server type | Emits `visibility`? |
|----------|-------------|---------------------|
| `POST /api/sdk/rooms` | `RoomResponse` | Yes (post-open-rooms servers) |
| `GET /api/sdk/rooms/:room_id` | `RoomResponse` | Yes (post-open-rooms servers) |
| `GET /api/sdk/rooms` | `RoomListItem` | **No** (as of 2026-06-13) |

The SDK defaults `visibility` to `member` (the server default) whenever the field is absent
in the wire response.  This keeps the domain types (`Room.visibility`, `RoomSummary.visibility`)
non-optional while being robust against:

- **Pre-open-rooms prod servers** — neither path emits `visibility` yet.
- **The list endpoint** — `RoomListItem` structurally omits `visibility` even on
  post-open-rooms staging.  Listed rooms therefore show `member` until a server
  follow-up adds the field to `RoomListItem` and its Rust `From` mapping:
  - Server file: `crates/sdk/src/rooms.rs` → `RoomListItem` struct + `From<DbRoom>` impl.

Until that server follow-up lands, **list-row visibility is not authoritative for open
rooms**.  Use `getRoom(roomId)` when you need the authoritative visibility for a specific room.
