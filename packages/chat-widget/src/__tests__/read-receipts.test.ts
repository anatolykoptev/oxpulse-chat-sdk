/**
 * #122: Read receipts tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ReadReceipts } from "../ui/read-receipts.js";

describe("ReadReceipts (#122)", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function makeBubble(msgId: string, seq: number): HTMLElement {
    const el = document.createElement("div");
    el.className = "oxp-bubble";
    el.setAttribute("data-msg-id", msgId);

    const footer = document.createElement("div");
    footer.className = "oxp-bubble-footer";

    const time = document.createElement("div");
    time.className = "oxp-bubble-time";
    time.textContent = "12:00";
    footer.appendChild(time);

    el.appendChild(footer);
    container.appendChild(el);
    return el;
  }

  it("registerBubble adds a receipt element with delivered status", () => {
    const rr = new ReadReceipts({ selfUid: "me", lang: "en" });
    const el = makeBubble("msg1", 10);
    rr.registerBubble("msg1", 10, el);

    const receipt = el.querySelector(".oxp-read-receipt") as HTMLElement;
    expect(receipt).toBeTruthy();
    expect(receipt.getAttribute("data-status")).toBe("delivered");
    rr.destroy();
  });

  it("onReadReceipt upgrades status to read when seq >= message seq", () => {
    const rr = new ReadReceipts({ selfUid: "me", lang: "en" });
    const el = makeBubble("msg1", 10);
    rr.registerBubble("msg1", 10, el);

    rr.onReadReceipt("alice", 10);

    const receipt = el.querySelector(".oxp-read-receipt") as HTMLElement;
    expect(receipt.getAttribute("data-status")).toBe("read");
    rr.destroy();
  });

  it("onReadReceipt does not upgrade when seq < message seq", () => {
    const rr = new ReadReceipts({ selfUid: "me", lang: "en" });
    const el = makeBubble("msg1", 10);
    rr.registerBubble("msg1", 10, el);

    rr.onReadReceipt("alice", 5);

    const receipt = el.querySelector(".oxp-read-receipt") as HTMLElement;
    expect(receipt.getAttribute("data-status")).toBe("delivered");
    rr.destroy();
  });

  it("onReadReceipt ignores self", () => {
    const rr = new ReadReceipts({ selfUid: "me", lang: "en" });
    const el = makeBubble("msg1", 10);
    rr.registerBubble("msg1", 10, el);

    rr.onReadReceipt("me", 10);

    const receipt = el.querySelector(".oxp-read-receipt") as HTMLElement;
    expect(receipt.getAttribute("data-status")).toBe("delivered");
    rr.destroy();
  });

  it("onReadReceipt is monotonic — lower seq does not downgrade", () => {
    const rr = new ReadReceipts({ selfUid: "me", lang: "en" });
    const el = makeBubble("msg1", 10);
    rr.registerBubble("msg1", 10, el);

    rr.onReadReceipt("alice", 15);
    expect(el.querySelector(".oxp-read-receipt")!.getAttribute("data-status")).toBe("read");

    rr.onReadReceipt("bob", 3);
    expect(el.querySelector(".oxp-read-receipt")!.getAttribute("data-status")).toBe("read");
    rr.destroy();
  });

  it("multiple users reading different seqs — max wins", () => {
    const rr = new ReadReceipts({ selfUid: "me", lang: "en" });
    const el1 = makeBubble("msg1", 5);
    const el2 = makeBubble("msg2", 10);
    rr.registerBubble("msg1", 5, el1);
    rr.registerBubble("msg2", 10, el2);

    rr.onReadReceipt("alice", 7);
    // msg1 (seq=5) is read, msg2 (seq=10) is not
    expect(el1.querySelector(".oxp-read-receipt")!.getAttribute("data-status")).toBe("read");
    expect(el2.querySelector(".oxp-read-receipt")!.getAttribute("data-status")).toBe("delivered");

    rr.onReadReceipt("bob", 10);
    // Now msg2 is also read
    expect(el2.querySelector(".oxp-read-receipt")!.getAttribute("data-status")).toBe("read");
    rr.destroy();
  });

  it("read status uses double checkmark SVG", () => {
    const rr = new ReadReceipts({ selfUid: "me", lang: "en" });
    const el = makeBubble("msg1", 10);
    rr.registerBubble("msg1", 10, el);
    rr.onReadReceipt("alice", 10);

    const receipt = el.querySelector(".oxp-read-receipt") as HTMLElement;
    const svg = receipt.querySelector("svg");
    expect(svg).toBeTruthy();
    // Double checkmark has two polyline elements
    expect(receipt.querySelectorAll("polyline").length).toBe(2);
    rr.destroy();
  });

  it("delivered status uses double checkmark SVG", () => {
    const rr = new ReadReceipts({ selfUid: "me", lang: "en" });
    const el = makeBubble("msg1", 10);
    rr.registerBubble("msg1", 10, el);

    const receipt = el.querySelector(".oxp-read-receipt") as HTMLElement;
    expect(receipt.querySelectorAll("polyline").length).toBe(2);
    rr.destroy();
  });

  it("receipt has aria-label with status text", () => {
    const rr = new ReadReceipts({ selfUid: "me", lang: "en" });
    const el = makeBubble("msg1", 10);
    rr.registerBubble("msg1", 10, el);

    const receipt = el.querySelector(".oxp-read-receipt") as HTMLElement;
    expect(receipt.getAttribute("aria-label")).toContain("Delivered");

    rr.onReadReceipt("alice", 10);
    expect(receipt.getAttribute("aria-label")).toContain("Read");
    rr.destroy();
  });

  it("Russian locale shows translated status", () => {
    const rr = new ReadReceipts({ selfUid: "me", lang: "ru" });
    const el = makeBubble("msg1", 10);
    rr.registerBubble("msg1", 10, el);

    const receipt = el.querySelector(".oxp-read-receipt") as HTMLElement;
    expect(receipt.getAttribute("aria-label")).toContain("Доставлено");

    rr.onReadReceipt("alice", 10);
    expect(receipt.getAttribute("aria-label")).toContain("Прочитано");
    rr.destroy();
  });

  it("clearAll resets all receipts to delivered", () => {
    const rr = new ReadReceipts({ selfUid: "me", lang: "en" });
    const el = makeBubble("msg1", 10);
    rr.registerBubble("msg1", 10, el);
    rr.onReadReceipt("alice", 10);
    expect(el.querySelector(".oxp-read-receipt")!.getAttribute("data-status")).toBe("read");

    rr.clearAll();
    expect(el.querySelector(".oxp-read-receipt")!.getAttribute("data-status")).toBe("delivered");
    rr.destroy();
  });

  it("unregisterBubble removes tracking", () => {
    const rr = new ReadReceipts({ selfUid: "me", lang: "en" });
    const el = makeBubble("msg1", 10);
    rr.registerBubble("msg1", 10, el);
    rr.unregisterBubble("msg1");

    // onReadReceipt after unregister should not update the DOM
    rr.onReadReceipt("alice", 10);
    expect(el.querySelector(".oxp-read-receipt")!.getAttribute("data-status")).toBe("delivered");
    rr.destroy();
  });

  it("destroy clears all state", () => {
    const rr = new ReadReceipts({ selfUid: "me", lang: "en" });
    const el = makeBubble("msg1", 10);
    rr.registerBubble("msg1", 10, el);
    rr.onReadReceipt("alice", 10);
    rr.destroy();

    // After destroy, onReadReceipt is a no-op
    rr.onReadReceipt("bob", 20);
    // The DOM element still exists but status should not change
    expect(el.querySelector(".oxp-read-receipt")!.getAttribute("data-status")).toBe("read");
  });

  it("maxReadSeq returns the highest seq across all users", () => {
    const rr = new ReadReceipts({ selfUid: "me", lang: "en" });
    rr.onReadReceipt("alice", 5);
    rr.onReadReceipt("bob", 15);
    expect(rr.maxReadSeq).toBe(15);
    rr.destroy();
  });

  it("receipt is inserted after timestamp in footer", () => {
    const rr = new ReadReceipts({ selfUid: "me", lang: "en" });
    const el = makeBubble("msg1", 10);
    rr.registerBubble("msg1", 10, el);

    const footer = el.querySelector(".oxp-bubble-footer")!;
    const time = footer.querySelector(".oxp-bubble-time")!;
    const receipt = footer.querySelector(".oxp-read-receipt")!;

    // Receipt should come after time in DOM order
    const children = Array.from(footer.children);
    expect(children.indexOf(time)).toBeLessThan(children.indexOf(receipt));
    rr.destroy();
  });
});
