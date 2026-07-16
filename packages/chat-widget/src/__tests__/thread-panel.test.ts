/**
 * #126: Thread panel tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ThreadPanel, type ThreadRow } from "../ui/thread-panel.js";

describe("ThreadPanel (#126)", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    container.style.position = "relative";
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  const mockRoot: ThreadRow = {
    msgId: "msg-root",
    senderUid: "alice",
    text: "Hello everyone!",
    createdAt: new Date("2026-07-16T10:00:00Z").toISOString(),
    threadRootMsgId: null,
  };

  const mockReplies: ThreadRow[] = [
    { msgId: "r1", senderUid: "bob", text: "Hi Alice!", createdAt: new Date("2026-07-16T10:01:00Z").toISOString(), threadRootMsgId: "msg-root" },
    { msgId: "r2", senderUid: "alice", text: "How are you?", createdAt: new Date("2026-07-16T10:02:00Z").toISOString(), threadRootMsgId: "msg-root" },
  ];

  function makePanel(opts?: Partial<{
    getThread: (rootMsgId: string) => Promise<ThreadRow[]>;
    sendReply: (text: string, rootMsgId: string) => Promise<void>;
    resolveName: (uid: string) => string | undefined;
    selfUid: string;
    lang: string;
    onClose: () => void;
  }>) {
    return new ThreadPanel({
      container,
      getThread: opts?.getThread ?? (() => Promise.resolve(mockReplies)),
      sendReply: opts?.sendReply ?? (() => Promise.resolve()),
      resolveName: opts?.resolveName ?? ((id: string) => id === "alice" ? "Alice" : id === "bob" ? "Bob" : undefined),
      selfUid: opts?.selfUid ?? "me",
      lang: opts?.lang ?? "en",
      onClose: opts?.onClose,
    });
  }

  it("open creates panel in container", async () => {
    const panel = makePanel();
    await panel.open(mockRoot);
    expect(container.querySelector(".oxp-thread-panel")).toBeTruthy();
    panel.close();
  });

  it("close removes panel from DOM", async () => {
    const panel = makePanel();
    await panel.open(mockRoot);
    panel.close();
    expect(container.querySelector(".oxp-thread-panel")).toBeNull();
  });

  it("isOpen reflects state", async () => {
    const panel = makePanel();
    expect(panel.isOpen).toBe(false);
    await panel.open(mockRoot);
    expect(panel.isOpen).toBe(true);
    panel.close();
    expect(panel.isOpen).toBe(false);
  });

  it("shows root message in panel", async () => {
    const panel = makePanel();
    await panel.open(mockRoot);
    const root = container.querySelector(".oxp-thread-root");
    expect(root).toBeTruthy();
    expect(root!.textContent).toContain("Hello everyone!");
    panel.close();
  });

  it("renders thread replies after fetch", async () => {
    const panel = makePanel();
    await panel.open(mockRoot);
    const bubbles = container.querySelectorAll(".oxp-thread-bubble");
    expect(bubbles.length).toBe(2);
    expect(bubbles[0]!.textContent).toContain("Hi Alice!");
    expect(bubbles[1]!.textContent).toContain("How are you?");
    panel.close();
  });

  it("shows loading state while fetching", async () => {
    let resolveFn: ((rows: ThreadRow[]) => void) | undefined;
    const panel = makePanel({
      getThread: () => new Promise((resolve) => { resolveFn = resolve; }),
    });
    void panel.open(mockRoot);
    // Panel should show loading before we resolve
    expect(container.querySelector(".oxp-thread-loading")).toBeTruthy();
    resolveFn?.([]);
    await new Promise((r) => setTimeout(r, 10));
    panel.close();
  });

  it("shows empty state when no replies", async () => {
    const panel = makePanel({ getThread: () => Promise.resolve([]) });
    await panel.open(mockRoot);
    expect(container.querySelector(".oxp-thread-empty")).toBeTruthy();
    expect(container.querySelector(".oxp-thread-empty")!.textContent).toBe("No replies yet");
    panel.close();
  });

  it("shows error state on fetch failure", async () => {
    const panel = makePanel({ getThread: () => Promise.reject(new Error("fail")) });
    await panel.open(mockRoot);
    expect(container.querySelector(".oxp-thread-error")).toBeTruthy();
    panel.close();
  });

  it("send button is disabled when input is empty", async () => {
    const panel = makePanel();
    await panel.open(mockRoot);
    const sendBtn = container.querySelector(".oxp-thread-send") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    panel.close();
  });

  it("send button enables when text is entered", async () => {
    const panel = makePanel();
    await panel.open(mockRoot);
    const input = container.querySelector(".oxp-thread-input") as HTMLTextAreaElement;
    const sendBtn = container.querySelector(".oxp-thread-send") as HTMLButtonElement;
    input.value = "Test reply";
    input.dispatchEvent(new Event("input"));
    expect(sendBtn.disabled).toBe(false);
    panel.close();
  });

  it("clicking send calls sendReply with text and rootMsgId", async () => {
    const sendReply = vi.fn(() => Promise.resolve());
    const panel = makePanel({ sendReply });
    await panel.open(mockRoot);
    const input = container.querySelector(".oxp-thread-input") as HTMLTextAreaElement;
    const sendBtn = container.querySelector(".oxp-thread-send") as HTMLButtonElement;
    input.value = "My reply";
    input.dispatchEvent(new Event("input"));
    sendBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(sendReply).toHaveBeenCalledWith("My reply", "msg-root");
    panel.close();
  });

  it("input is cleared after successful send", async () => {
    const panel = makePanel();
    await panel.open(mockRoot);
    const input = container.querySelector(".oxp-thread-input") as HTMLTextAreaElement;
    const sendBtn = container.querySelector(".oxp-thread-send") as HTMLButtonElement;
    input.value = "Reply text";
    input.dispatchEvent(new Event("input"));
    sendBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(input.value).toBe("");
    panel.close();
  });

  it("Enter sends reply (Shift+Enter does not)", async () => {
    const sendReply = vi.fn(() => Promise.resolve());
    const panel = makePanel({ sendReply });
    await panel.open(mockRoot);
    const input = container.querySelector(".oxp-thread-input") as HTMLTextAreaElement;
    input.value = "Enter reply";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(sendReply).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: false }));
    await new Promise((r) => setTimeout(r, 10));
    expect(sendReply).toHaveBeenCalledTimes(1);
    panel.close();
  });

  it("Escape closes the panel", async () => {
    const onClose = vi.fn();
    const panel = makePanel({ onClose });
    await panel.open(mockRoot);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(container.querySelector(".oxp-thread-panel")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("close button closes the panel", async () => {
    const panel = makePanel();
    await panel.open(mockRoot);
    const closeBtn = container.querySelector(".oxp-thread-close") as HTMLButtonElement;
    closeBtn.click();
    expect(container.querySelector(".oxp-thread-panel")).toBeNull();
  });

  it("onClose fires when panel closes", async () => {
    const onClose = vi.fn();
    const panel = makePanel({ onClose });
    await panel.open(mockRoot);
    panel.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("addReply appends a new reply bubble", async () => {
    const panel = makePanel();
    await panel.open(mockRoot);
    const initialCount = container.querySelectorAll(".oxp-thread-bubble").length;
    panel.addReply({ msgId: "r3", senderUid: "bob", text: "New reply", createdAt: new Date().toISOString(), threadRootMsgId: "msg-root" });
    expect(container.querySelectorAll(".oxp-thread-bubble").length).toBe(initialCount + 1);
    panel.close();
  });

  it("addReply ignores messages from different threads", async () => {
    const panel = makePanel();
    await panel.open(mockRoot);
    const initialCount = container.querySelectorAll(".oxp-thread-bubble").length;
    panel.addReply({ msgId: "r3", senderUid: "bob", text: "Other thread", createdAt: new Date().toISOString(), threadRootMsgId: "other-root" });
    expect(container.querySelectorAll(".oxp-thread-bubble").length).toBe(initialCount);
    panel.close();
  });

  it("self messages have data-self=true", async () => {
    const panel = makePanel({ selfUid: "alice" });
    await panel.open(mockRoot);
    const bubbles = container.querySelectorAll(".oxp-thread-bubble");
    // r1 is from bob (not self), r2 is from alice (self)
    expect(bubbles[0]!.getAttribute("data-self")).toBe("false");
    expect(bubbles[1]!.getAttribute("data-self")).toBe("true");
    panel.close();
  });

  it("Russian locale shows translated title", async () => {
    const panel = makePanel({ lang: "ru" });
    await panel.open(mockRoot);
    const title = container.querySelector(".oxp-thread-title");
    expect(title!.textContent).toBe("Тред");
    panel.close();
  });

  it("Russian locale shows translated empty state", async () => {
    const panel = makePanel({ lang: "ru", getThread: () => Promise.resolve([]) });
    await panel.open(mockRoot);
    const empty = container.querySelector(".oxp-thread-empty");
    expect(empty!.textContent).toBe("Пока нет ответов");
    panel.close();
  });

  it("panel has role=dialog and aria-modal", async () => {
    const panel = makePanel();
    await panel.open(mockRoot);
    const el = container.querySelector(".oxp-thread-panel") as HTMLElement;
    expect(el.getAttribute("role")).toBe("dialog");
    expect(el.getAttribute("aria-modal")).toBe("true");
    panel.close();
  });

  it("root message shows sender name", async () => {
    const panel = makePanel();
    await panel.open(mockRoot);
    const rootSender = container.querySelector(".oxp-thread-root-sender");
    expect(rootSender!.textContent).toBe("Alice");
    panel.close();
  });

  it("root message shows 'You' for self", async () => {
    const panel = makePanel({ selfUid: "alice" });
    await panel.open(mockRoot);
    const rootSender = container.querySelector(".oxp-thread-root-sender");
    expect(rootSender!.textContent).toBe("You");
    panel.close();
  });
});
