/**
 * #121: Presence overlay tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PresenceOverlay } from "../ui/presence-overlay.js";

describe("PresenceOverlay (#121)", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.useFakeTimers();
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
  });

  function makeAvatar(userId: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "oxp-bubble-avatar";
    container.appendChild(el);
    return el;
  }

  it("isOnline returns false for unknown user", () => {
    const po = new PresenceOverlay({ selfUid: "me", lang: "en" });
    expect(po.isOnline("alice")).toBe(false);
    po.destroy();
  });

  it("isOnline returns true after updatePresence with recent timestamp", () => {
    const po = new PresenceOverlay({ selfUid: "me", lang: "en" });
    po.updatePresence("alice", new Date().toISOString());
    expect(po.isOnline("alice")).toBe(true);
    po.destroy();
  });

  it("isOnline returns false after freshness window expires", () => {
    const po = new PresenceOverlay({ selfUid: "me", lang: "en", freshnessSecs: 60 });
    const oldTs = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    po.updatePresence("alice", oldTs);
    expect(po.isOnline("alice")).toBe(false);
    po.destroy();
  });

  it("adds online dot to registered avatar", () => {
    const po = new PresenceOverlay({ selfUid: "me", lang: "en" });
    const avatar = makeAvatar("alice");
    po.updatePresence("alice", new Date().toISOString());
    po.registerAvatar("alice", avatar);

    const dot = avatar.querySelector(".oxp-presence-dot") as HTMLElement;
    expect(dot).toBeTruthy();
    expect(dot.getAttribute("data-status")).toBe("online");
    po.destroy();
  });

  it("does not add dot for offline user", () => {
    const po = new PresenceOverlay({ selfUid: "me", lang: "en", freshnessSecs: 60 });
    const avatar = makeAvatar("alice");
    const oldTs = new Date(Date.now() - 120_000).toISOString();
    po.updatePresence("alice", oldTs);
    po.registerAvatar("alice", avatar);

    const dot = avatar.querySelector(".oxp-presence-dot");
    expect(dot).toBeNull();
    po.destroy();
  });

  it("does not add dot on own avatar", () => {
    const po = new PresenceOverlay({ selfUid: "me", lang: "en" });
    const avatar = makeAvatar("me");
    po.updatePresence("me", new Date().toISOString());
    po.registerAvatar("me", avatar);

    const dot = avatar.querySelector(".oxp-presence-dot");
    expect(dot).toBeNull();
    po.destroy();
  });

  it("removes dot when user goes offline (freshness expires)", () => {
    const po = new PresenceOverlay({ selfUid: "me", lang: "en", freshnessSecs: 60 });
    const avatar = makeAvatar("alice");
    po.updatePresence("alice", new Date().toISOString());
    po.registerAvatar("alice", avatar);

    let dot = avatar.querySelector(".oxp-presence-dot");
    expect(dot).toBeTruthy();

    // Advance past freshness window
    vi.advanceTimersByTime(61_000);
    // Trigger a refresh by updating with stale timestamp
    po.updatePresence("alice", new Date(Date.now() - 120_000).toISOString());

    dot = avatar.querySelector(".oxp-presence-dot");
    expect(dot).toBeNull();
    po.destroy();
  });

  it("setSnapshot bulk-sets presence from array", () => {
    const po = new PresenceOverlay({ selfUid: "me", lang: "en" });
    po.setSnapshot([
      { userId: "alice", lastSeenAt: new Date().toISOString() },
      { userId: "bob", lastSeenAt: new Date().toISOString() },
    ]);
    expect(po.isOnline("alice")).toBe(true);
    expect(po.isOnline("bob")).toBe(true);
    po.destroy();
  });

  it("startHeartbeat calls callback immediately and on interval", () => {
    const po = new PresenceOverlay({ selfUid: "me", lang: "en", heartbeatSecs: 30 });
    const cb = vi.fn();
    po.startHeartbeat(cb);

    expect(cb).toHaveBeenCalledTimes(1); // immediate

    vi.advanceTimersByTime(30_000);
    expect(cb).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(30_000);
    expect(cb).toHaveBeenCalledTimes(3);
    po.destroy();
  });

  it("destroy clears heartbeat interval", () => {
    const po = new PresenceOverlay({ selfUid: "me", lang: "en", heartbeatSecs: 30 });
    const cb = vi.fn();
    po.startHeartbeat(cb);
    po.destroy();

    const callCount = cb.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(cb.mock.calls.length).toBe(callCount); // no more calls
  });

  it("destroy removes all dots from avatars", () => {
    const po = new PresenceOverlay({ selfUid: "me", lang: "en" });
    const avatar1 = makeAvatar("alice");
    const avatar2 = makeAvatar("bob");
    po.updatePresence("alice", new Date().toISOString());
    po.updatePresence("bob", new Date().toISOString());
    po.registerAvatar("alice", avatar1);
    po.registerAvatar("bob", avatar2);

    expect(avatar1.querySelector(".oxp-presence-dot")).toBeTruthy();
    expect(avatar2.querySelector(".oxp-presence-dot")).toBeTruthy();

    po.destroy();

    expect(avatar1.querySelector(".oxp-presence-dot")).toBeNull();
    expect(avatar2.querySelector(".oxp-presence-dot")).toBeNull();
  });

  it("unregisterAvatar removes tracking", () => {
    const po = new PresenceOverlay({ selfUid: "me", lang: "en" });
    const avatar = makeAvatar("alice");
    po.updatePresence("alice", new Date().toISOString());
    po.registerAvatar("alice", avatar);
    po.unregisterAvatar("alice");

    // Update after unregister should not add a dot
    po.updatePresence("alice", new Date().toISOString());
    expect(avatar.querySelector(".oxp-presence-dot")).toBeNull();
    po.destroy();
  });

  it("clearAll removes all dots", () => {
    const po = new PresenceOverlay({ selfUid: "me", lang: "en" });
    const avatar1 = makeAvatar("alice");
    const avatar2 = makeAvatar("bob");
    po.updatePresence("alice", new Date().toISOString());
    po.updatePresence("bob", new Date().toISOString());
    po.registerAvatar("alice", avatar1);
    po.registerAvatar("bob", avatar2);

    po.clearAll();

    expect(avatar1.querySelector(".oxp-presence-dot")).toBeNull();
    expect(avatar2.querySelector(".oxp-presence-dot")).toBeNull();
    po.destroy();
  });

  it("getLastSeen returns timestamp for known user", () => {
    const po = new PresenceOverlay({ selfUid: "me", lang: "en" });
    const ts = Date.now();
    po.updatePresence("alice", ts);
    expect(po.getLastSeen("alice")).toBe(ts);
    expect(po.getLastSeen("unknown")).toBeUndefined();
    po.destroy();
  });

  it("ignores invalid timestamp", () => {
    const po = new PresenceOverlay({ selfUid: "me", lang: "en" });
    po.updatePresence("alice", "not-a-date");
    expect(po.isOnline("alice")).toBe(false);
    po.destroy();
  });

  it("online dot has aria-label", () => {
    const po = new PresenceOverlay({
      selfUid: "me",
      lang: "en",
      resolveName: (id) => (id === "alice" ? "Alice" : id),
    });
    const avatar = makeAvatar("alice");
    po.updatePresence("alice", new Date().toISOString());
    po.registerAvatar("alice", avatar);

    const dot = avatar.querySelector(".oxp-presence-dot") as HTMLElement;
    expect(dot.getAttribute("aria-label")).toBe("Online");
    po.destroy();
  });

  it("Russian locale shows translated aria-label", () => {
    const po = new PresenceOverlay({
      selfUid: "me",
      lang: "ru",
      resolveName: (id) => "Алиса",
    });
    const avatar = makeAvatar("alice");
    po.updatePresence("alice", new Date().toISOString());
    po.registerAvatar("alice", avatar);

    const dot = avatar.querySelector(".oxp-presence-dot") as HTMLElement;
    expect(dot.getAttribute("aria-label")).toBe("В сети");
    po.destroy();
  });
});
