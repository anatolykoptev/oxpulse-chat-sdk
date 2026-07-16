/**
 * #120: Typing indicator tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TypingIndicator } from "../ui/typing-indicator.js";

describe("TypingIndicator (#120)", () => {
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

  it("hides indicator when no users are typing", () => {
    const ti = new TypingIndicator({ container, selfUid: "me", lang: "en" });
    // No addTyping called — indicator should be hidden
    const root = container.querySelector(".oxp-typing-indicator") as HTMLElement;
    expect(root).toBeTruthy();
    expect(root.style.display).toBe("none");
    ti.destroy();
  });

  it("shows 'X is typing…' for one user", () => {
    const ti = new TypingIndicator({
      container,
      selfUid: "me",
      lang: "en",
      resolveName: (id) => (id === "alice" ? "Alice" : id),
    });
    ti.addTyping("alice", 5);

    const root = container.querySelector(".oxp-typing-indicator") as HTMLElement;
    expect(root.style.display).toBe("flex");

    const text = container.querySelector(".oxp-typing-text") as HTMLElement;
    expect(text.textContent).toBe("Alice is typing…");
    ti.destroy();
  });

  it("shows 'X and Y are typing…' for two users", () => {
    const ti = new TypingIndicator({
      container,
      selfUid: "me",
      lang: "en",
      resolveName: (id) => (id === "alice" ? "Alice" : id === "bob" ? "Bob" : id),
    });
    ti.addTyping("alice", 5);
    ti.addTyping("bob", 5);

    const text = container.querySelector(".oxp-typing-text") as HTMLElement;
    expect(text.textContent).toBe("Alice and Bob are typing…");
    ti.destroy();
  });

  it("shows 'X, Y and N others are typing…' for 3+ users", () => {
    const ti = new TypingIndicator({
      container,
      selfUid: "me",
      lang: "en",
      resolveName: (id) => `User-${id}`,
    });
    ti.addTyping("a", 5);
    ti.addTyping("b", 5);
    ti.addTyping("c", 5);
    ti.addTyping("d", 5);

    const text = container.querySelector(".oxp-typing-text") as HTMLElement;
    expect(text.textContent).toBe("User-a, User-b and 2 others are typing…");
    ti.destroy();
  });

  it("filters out self typing", () => {
    const ti = new TypingIndicator({ container, selfUid: "me", lang: "en" });
    ti.addTyping("me", 5);

    const root = container.querySelector(".oxp-typing-indicator") as HTMLElement;
    expect(root.style.display).toBe("none");
    ti.destroy();
  });

  it("auto-removes user after TTL expires", () => {
    const ti = new TypingIndicator({
      container,
      selfUid: "me",
      lang: "en",
      resolveName: (id) => "Alice",
    });
    ti.addTyping("alice", 2); // 2 second TTL

    const text = container.querySelector(".oxp-typing-text") as HTMLElement;
    expect(text.textContent).toBe("Alice is typing…");

    // Advance past TTL
    vi.advanceTimersByTime(2100);

    const root = container.querySelector(".oxp-typing-indicator") as HTMLElement;
    expect(root.style.display).toBe("none");
    ti.destroy();
  });

  it("removeTyping clears a user immediately", () => {
    const ti = new TypingIndicator({
      container,
      selfUid: "me",
      lang: "en",
      resolveName: () => "Alice",
    });
    ti.addTyping("alice", 10);
    ti.removeTyping("alice");

    const root = container.querySelector(".oxp-typing-indicator") as HTMLElement;
    expect(root.style.display).toBe("none");
    ti.destroy();
  });

  it("clearAll removes all typing users", () => {
    const ti = new TypingIndicator({
      container,
      selfUid: "me",
      lang: "en",
      resolveName: (id) => id,
    });
    ti.addTyping("a", 10);
    ti.addTyping("b", 10);
    ti.clearAll();

    const root = container.querySelector(".oxp-typing-indicator") as HTMLElement;
    expect(root.style.display).toBe("none");
    ti.destroy();
  });

  it("renewing typing resets the TTL timer", () => {
    const ti = new TypingIndicator({
      container,
      selfUid: "me",
      lang: "en",
      resolveName: () => "Alice",
    });
    ti.addTyping("alice", 2);

    // Advance 1.5s — not yet expired
    vi.advanceTimersByTime(1500);
    let root = container.querySelector(".oxp-typing-indicator") as HTMLElement;
    expect(root.style.display).toBe("flex");

    // Renew typing — resets timer
    ti.addTyping("alice", 2);

    // Advance another 1.5s — original timer would have fired, but renewed hasn't
    vi.advanceTimersByTime(1500);
    root = container.querySelector(".oxp-typing-indicator") as HTMLElement;
    expect(root.style.display).toBe("flex");

    // Advance past renewed TTL
    vi.advanceTimersByTime(600);
    root = container.querySelector(".oxp-typing-indicator") as HTMLElement;
    expect(root.style.display).toBe("none");
    ti.destroy();
  });

  it("Russian locale shows translated text", () => {
    const ti = new TypingIndicator({
      container,
      selfUid: "me",
      lang: "ru",
      resolveName: () => "Алиса",
    });
    ti.addTyping("alice", 5);

    const text = container.querySelector(".oxp-typing-text") as HTMLElement;
    expect(text.textContent).toBe("Алиса печатает…");
    ti.destroy();
  });

  it("destroy removes the DOM element and clears timers", () => {
    const ti = new TypingIndicator({
      container,
      selfUid: "me",
      lang: "en",
      resolveName: () => "Alice",
    });
    ti.addTyping("alice", 10);
    ti.destroy();

    expect(container.querySelector(".oxp-typing-indicator")).toBeNull();
    // addTyping after destroy is a no-op
    ti.addTyping("bob", 5);
    expect(container.querySelector(".oxp-typing-indicator")).toBeNull();
  });

  it("falls back to userId when resolveName returns undefined", () => {
    const ti = new TypingIndicator({
      container,
      selfUid: "me",
      lang: "en",
      resolveName: () => undefined,
    });
    ti.addTyping("alice123", 5);

    const text = container.querySelector(".oxp-typing-text") as HTMLElement;
    expect(text.textContent).toBe("alice123 is typing…");
    ti.destroy();
  });
});
