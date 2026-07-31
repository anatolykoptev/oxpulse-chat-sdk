/**
 * #228: Pinned messages banner tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PinnedBanner } from "../ui/pinned-banner.js";

describe("PinnedBanner (#228)", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("hides banner when no pins are set", () => {
    const banner = new PinnedBanner({ container, lang: "en" });
    const root = container.querySelector(".oxp-pinned-banner") as HTMLElement;
    expect(root).toBeTruthy();
    expect(root.style.display).toBe("none");
    banner.destroy();
  });

  it("shows banner with preview text when setPins is called", () => {
    const banner = new PinnedBanner({
      container,
      lang: "en",
      resolvePreview: (msgId) => (msgId === "msg1" ? "Hello world" : undefined),
      resolveName: (uid) => (uid === "alice" ? "Alice" : uid),
    });
    banner.setPins([{ msgId: "msg1", pinnedBy: "alice", pinnedAt: "2026-07-31T00:00:00Z" }]);

    const root = container.querySelector(".oxp-pinned-banner") as HTMLElement;
    expect(root.style.display).toBe("flex");

    const preview = container.querySelector(".oxp-pinned-banner-preview") as HTMLElement;
    expect(preview.textContent).toBe("Hello world");

    const meta = container.querySelector(".oxp-pinned-banner-meta") as HTMLElement;
    expect(meta.textContent).toBe("Pinned by Alice");
    banner.destroy();
  });

  it("shows 'Message not loaded' when preview is unavailable", () => {
    const banner = new PinnedBanner({
      container,
      lang: "en",
      resolvePreview: () => undefined,
    });
    banner.setPins([{ msgId: "msg1", pinnedBy: "bob", pinnedAt: "2026-07-31T00:00:00Z" }]);

    const preview = container.querySelector(".oxp-pinned-banner-preview") as HTMLElement;
    expect(preview.textContent).toBe("Pinned message not loaded");
    expect(preview.getAttribute("data-not-loaded")).toBe("true");
    banner.destroy();
  });

  it("shows carousel nav (◀ ▶ + counter) when >1 pin", () => {
    const banner = new PinnedBanner({
      container,
      lang: "en",
      resolvePreview: () => "preview",
    });
    banner.setPins([
      { msgId: "msg1", pinnedBy: "alice", pinnedAt: "2026-07-31T01:00:00Z" },
      { msgId: "msg2", pinnedBy: "bob", pinnedAt: "2026-07-31T00:00:00Z" },
      { msgId: "msg3", pinnedBy: "carol", pinnedAt: "2026-07-30T23:00:00Z" },
    ]);

    const root = container.querySelector(".oxp-pinned-banner") as HTMLElement;
    expect(root.getAttribute("data-multi")).toBe("true");

    const counter = container.querySelector(".oxp-pinned-banner-counter") as HTMLElement;
    expect(counter.textContent).toBe("1/3");
    expect(counter.style.display).not.toBe("none");
    banner.destroy();
  });

  it("hides carousel nav when only 1 pin", () => {
    const banner = new PinnedBanner({
      container,
      lang: "en",
      resolvePreview: () => "preview",
    });
    banner.setPins([{ msgId: "msg1", pinnedBy: "alice", pinnedAt: "2026-07-31T00:00:00Z" }]);

    const root = container.querySelector(".oxp-pinned-banner") as HTMLElement;
    expect(root.hasAttribute("data-multi")).toBe(false);

    const counter = container.querySelector(".oxp-pinned-banner-counter") as HTMLElement;
    expect(counter.style.display).toBe("none");
    banner.destroy();
  });

  it("cycles through pins with addPin/removePin (live SSE)", () => {
    const banner = new PinnedBanner({
      container,
      lang: "en",
      resolvePreview: (id) => `preview-${id}`,
    });
    banner.setPins([{ msgId: "msg1", pinnedBy: "alice", pinnedAt: "2026-07-31T01:00:00Z" }]);

    // addPin prepends (newest first)
    banner.addPin("msg2", "bob", "2026-07-31T02:00:00Z");
    expect(banner.isPinned("msg1")).toBe(true);
    expect(banner.isPinned("msg2")).toBe(true);

    const counter = container.querySelector(".oxp-pinned-banner-counter") as HTMLElement;
    expect(counter.textContent).toBe("1/2");

    // removePin — back to 1 pin, carousel nav hides
    banner.removePin("msg1");
    expect(banner.isPinned("msg1")).toBe(false);
    expect(counter.style.display).toBe("none");
    banner.destroy();
  });

  it("addPin is idempotent — duplicate msgId is a no-op", () => {
    const banner = new PinnedBanner({ container, lang: "en", resolvePreview: () => "p" });
    banner.setPins([{ msgId: "msg1", pinnedBy: "alice", pinnedAt: "2026-07-31T01:00:00Z" }]);
    banner.addPin("msg1", "alice", "2026-07-31T02:00:00Z");
    expect(banner.getPinnedMsgIds().size).toBe(1);
    banner.destroy();
  });

  it("removePin is a no-op when msgId not pinned", () => {
    const banner = new PinnedBanner({ container, lang: "en" });
    banner.setPins([{ msgId: "msg1", pinnedBy: "alice", pinnedAt: "2026-07-31T01:00:00Z" }]);
    banner.removePin("nonexistent");
    expect(banner.isPinned("msg1")).toBe(true);
    banner.destroy();
  });

  it("close button dismisses the banner", () => {
    const banner = new PinnedBanner({
      container,
      lang: "en",
      resolvePreview: () => "preview",
    });
    banner.setPins([{ msgId: "msg1", pinnedBy: "alice", pinnedAt: "2026-07-31T00:00:00Z" }]);

    const root = container.querySelector(".oxp-pinned-banner") as HTMLElement;
    expect(root.style.display).toBe("flex");

    const closeBtn = container.querySelector(".oxp-pinned-banner-close") as HTMLButtonElement;
    closeBtn.click();

    expect(root.style.display).toBe("none");
    banner.destroy();
  });

  it("addPin re-shows a dismissed banner", () => {
    const banner = new PinnedBanner({
      container,
      lang: "en",
      resolvePreview: () => "preview",
    });
    banner.setPins([{ msgId: "msg1", pinnedBy: "alice", pinnedAt: "2026-07-31T00:00:00Z" }]);

    const closeBtn = container.querySelector(".oxp-pinned-banner-close") as HTMLButtonElement;
    closeBtn.click();

    const root = container.querySelector(".oxp-pinned-banner") as HTMLElement;
    expect(root.style.display).toBe("none");

    // A new pin re-shows the banner
    banner.addPin("msg2", "bob", "2026-07-31T02:00:00Z");
    expect(root.style.display).toBe("flex");
    banner.destroy();
  });

  it("calls onJumpToMessage when preview is clicked", () => {
    let jumpedTo: string | undefined;
    const banner = new PinnedBanner({
      container,
      lang: "en",
      resolvePreview: () => "preview",
      onJumpToMessage: (msgId) => { jumpedTo = msgId; },
    });
    banner.setPins([{ msgId: "msg1", pinnedBy: "alice", pinnedAt: "2026-07-31T00:00:00Z" }]);

    const preview = container.querySelector(".oxp-pinned-banner-preview") as HTMLButtonElement;
    preview.click();

    expect(jumpedTo).toBe("msg1");
    banner.destroy();
  });

  it("inserts before the reference element when insertBefore is provided", () => {
    const refEl = document.createElement("div");
    refEl.id = "ref";
    container.appendChild(refEl);

    const banner = new PinnedBanner({ container, insertBefore: refEl, lang: "en" });
    const root = container.querySelector(".oxp-pinned-banner") as HTMLElement;
    expect(root.nextSibling).toBe(refEl);
    banner.destroy();
  });

  it("uses Russian strings when lang=ru", () => {
    const banner = new PinnedBanner({
      container,
      lang: "ru",
      resolvePreview: () => undefined,
    });
    banner.setPins([{ msgId: "msg1", pinnedBy: "alice", pinnedAt: "2026-07-31T00:00:00Z" }]);

    const preview = container.querySelector(".oxp-pinned-banner-preview") as HTMLElement;
    expect(preview.textContent).toBe("Закреплённое сообщение не загружено");

    const meta = container.querySelector(".oxp-pinned-banner-meta") as HTMLElement;
    expect(meta.textContent).toBe("Закрепил(а) alice");
    banner.destroy();
  });

  // R2: setLoading shows a loading placeholder while listPins is in-flight.
  it("shows loading placeholder when setLoading(true) is called with no pins", () => {
    const banner = new PinnedBanner({ container, lang: "en" });
    banner.setLoading(true);

    const root = container.querySelector(".oxp-pinned-banner") as HTMLElement;
    expect(root.style.display).toBe("flex");

    const preview = container.querySelector(".oxp-pinned-banner-preview") as HTMLElement;
    expect(preview.textContent).toBe("Loading pinned messages…");
    expect(preview.getAttribute("data-not-loaded")).toBe("true");

    const counter = container.querySelector(".oxp-pinned-banner-counter") as HTMLElement;
    expect(counter.style.display).toBe("none");
    banner.destroy();
  });

  it("hides banner when setLoading(false) is called with no pins", () => {
    const banner = new PinnedBanner({ container, lang: "en" });
    banner.setLoading(true);
    banner.setLoading(false);

    const root = container.querySelector(".oxp-pinned-banner") as HTMLElement;
    expect(root.style.display).toBe("none");
    banner.destroy();
  });

  // R3: ARIA attributes for accessibility.
  it("sets role=region and aria-label on the banner root", () => {
    const banner = new PinnedBanner({ container, lang: "en" });
    banner.setPins([{ msgId: "msg1", pinnedBy: "alice", pinnedAt: "2026-07-31T00:00:00Z" }]);

    const root = container.querySelector(".oxp-pinned-banner") as HTMLElement;
    expect(root.getAttribute("role")).toBe("region");
    expect(root.getAttribute("aria-label")).toBe("Pinned message");
    banner.destroy();
  });

  it("sets aria-live=polite on the banner content area", () => {
    const banner = new PinnedBanner({ container, lang: "en" });
    banner.setPins([{ msgId: "msg1", pinnedBy: "alice", pinnedAt: "2026-07-31T00:00:00Z" }]);

    const content = container.querySelector(".oxp-pinned-banner-content") as HTMLElement;
    expect(content.getAttribute("aria-live")).toBe("polite");
    banner.destroy();
  });

  it("sets aria-labels on nav and close buttons", () => {
    const banner = new PinnedBanner({ container, lang: "en" });
    banner.setPins([
      { msgId: "msg1", pinnedBy: "alice", pinnedAt: "2026-07-31T00:00:00Z" },
      { msgId: "msg2", pinnedBy: "bob", pinnedAt: "2026-07-31T00:01:00Z" },
    ]);

    // Both nav buttons share .oxp-pinned-banner-nav-btn — select by text content.
    const navBtns = container.querySelectorAll(".oxp-pinned-banner-nav-btn");
    expect(navBtns.length).toBe(2);
    const prevBtn = navBtns[0] as HTMLElement;
    const nextBtn = navBtns[1] as HTMLElement;
    const closeBtn = container.querySelector(".oxp-pinned-banner-close") as HTMLElement;
    expect(prevBtn.getAttribute("aria-label")).toBe("Previous pinned message");
    expect(nextBtn.getAttribute("aria-label")).toBe("Next pinned message");
    expect(closeBtn.getAttribute("aria-label")).toBe("Close pinned banner");
    banner.destroy();
  });
});
