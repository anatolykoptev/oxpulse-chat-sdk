/**
 * #127: Emoji picker tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EmojiPicker } from "../ui/emoji-picker.js";
import { searchEmojis, ALL_EMOJIS, EMOJI_CATEGORIES } from "../utils/emoji-data.js";

describe("emoji-data (#127)", () => {
  it("ALL_EMOJIS is non-empty", () => {
    expect(ALL_EMOJIS.length).toBeGreaterThan(100);
  });

  it("searchEmojis returns all for empty query", () => {
    expect(searchEmojis("").length).toBe(ALL_EMOJIS.length);
  });

  it("searchEmojis filters by name", () => {
    const results = searchEmojis("heart");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((e) => e.name.includes("heart") || e.keywords.some((k) => k.includes("heart")))).toBe(true);
  });

  it("searchEmojis filters by keyword", () => {
    const results = searchEmojis("love");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((e) => e.char === "❤️")).toBe(true);
  });

  it("searchEmojis is case-insensitive", () => {
    const lower = searchEmojis("fire");
    const upper = searchEmojis("FIRE");
    expect(lower.length).toBe(upper.length);
  });

  it("searchEmojis returns empty for nonsense query", () => {
    expect(searchEmojis("xyzqwerty").length).toBe(0);
  });

  it("EMOJI_CATEGORIES has 8 categories", () => {
    expect(EMOJI_CATEGORIES.length).toBe(8);
  });

  it("every category has emojis", () => {
    for (const cat of EMOJI_CATEGORIES) {
      expect(cat.emojis.length).toBeGreaterThan(0);
    }
  });
});

describe("EmojiPicker (#127)", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("show creates picker element in container", () => {
    const picker = new EmojiPicker({ container, onSelect: () => {}, lang: "en" });
    const anchor = document.createElement("button");
    container.appendChild(anchor);
    picker.show(anchor);

    expect(container.querySelector(".oxp-emoji-picker")).toBeTruthy();
    picker.hide();
  });

  it("hide removes picker from DOM", () => {
    const picker = new EmojiPicker({ container, onSelect: () => {}, lang: "en" });
    const anchor = document.createElement("button");
    container.appendChild(anchor);
    picker.show(anchor);
    picker.hide();

    expect(container.querySelector(".oxp-emoji-picker")).toBeNull();
  });

  it("isOpen reflects picker state", () => {
    const picker = new EmojiPicker({ container, onSelect: () => {}, lang: "en" });
    const anchor = document.createElement("button");
    container.appendChild(anchor);

    expect(picker.isOpen).toBe(false);
    picker.show(anchor);
    expect(picker.isOpen).toBe(true);
    picker.hide();
    expect(picker.isOpen).toBe(false);
  });

  it("onSelect fires when emoji is clicked", () => {
    const onSelect = vi.fn();
    const picker = new EmojiPicker({ container, onSelect, lang: "en" });
    const anchor = document.createElement("button");
    container.appendChild(anchor);
    picker.show(anchor);

    const firstEmoji = container.querySelector(".oxp-emoji-picker-emoji") as HTMLButtonElement;
    expect(firstEmoji).toBeTruthy();
    firstEmoji.click();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(typeof onSelect.mock.calls[0]![0]).toBe("string");
  });

  it("search input filters emojis", () => {
    const picker = new EmojiPicker({ container, onSelect: () => {}, lang: "en" });
    const anchor = document.createElement("button");
    container.appendChild(anchor);
    picker.show(anchor);

    const allEmojis = container.querySelectorAll(".oxp-emoji-picker-emoji");
    expect(allEmojis.length).toBeGreaterThan(50);

    const searchInput = container.querySelector(".oxp-emoji-picker-input") as HTMLInputElement;
    searchInput.value = "fire";
    searchInput.dispatchEvent(new Event("input"));

    const filtered = container.querySelectorAll(".oxp-emoji-picker-emoji");
    expect(filtered.length).toBeLessThan(allEmojis.length);
    expect(filtered.length).toBeGreaterThan(0);
    picker.hide();
  });

  it("search shows no-results message for nonsense query", () => {
    const picker = new EmojiPicker({ container, onSelect: () => {}, lang: "en" });
    const anchor = document.createElement("button");
    container.appendChild(anchor);
    picker.show(anchor);

    const searchInput = container.querySelector(".oxp-emoji-picker-input") as HTMLInputElement;
    searchInput.value = "xyzqwerty";
    searchInput.dispatchEvent(new Event("input"));

    const empty = container.querySelector(".oxp-emoji-picker-empty");
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toBe("No emoji found");
    picker.hide();
  });

  it("category tabs switch to category emojis", () => {
    const picker = new EmojiPicker({ container, onSelect: () => {}, lang: "en" });
    const anchor = document.createElement("button");
    container.appendChild(anchor);
    picker.show(anchor);

    const tabs = container.querySelectorAll(".oxp-emoji-picker-tab");
    expect(tabs.length).toBe(8);

    // Click second tab
    (tabs[1] as HTMLButtonElement).click();
    const tabEmojis = container.querySelectorAll(".oxp-emoji-picker-emoji");
    expect(tabEmojis.length).toBeGreaterThan(0);
    expect(tabEmojis.length).toBeLessThan(ALL_EMOJIS.length);
    picker.hide();
  });

  it("first tab is selected by default", () => {
    const picker = new EmojiPicker({ container, onSelect: () => {}, lang: "en" });
    const anchor = document.createElement("button");
    container.appendChild(anchor);
    picker.show(anchor);

    const firstTab = container.querySelector(".oxp-emoji-picker-tab") as HTMLButtonElement;
    expect(firstTab.getAttribute("aria-selected")).toBe("true");
    picker.hide();
  });

  it("picker has role=dialog and aria-modal", () => {
    const picker = new EmojiPicker({ container, onSelect: () => {}, lang: "en" });
    const anchor = document.createElement("button");
    container.appendChild(anchor);
    picker.show(anchor);

    const el = container.querySelector(".oxp-emoji-picker") as HTMLElement;
    expect(el.getAttribute("role")).toBe("dialog");
    expect(el.getAttribute("aria-modal")).toBe("true");
    picker.hide();
  });

  it("search input has aria-label", () => {
    const picker = new EmojiPicker({ container, onSelect: () => {}, lang: "en" });
    const anchor = document.createElement("button");
    container.appendChild(anchor);
    picker.show(anchor);

    const input = container.querySelector(".oxp-emoji-picker-input") as HTMLInputElement;
    expect(input.getAttribute("aria-label")).toBeTruthy();
    picker.hide();
  });

  it("Russian locale shows translated search placeholder", () => {
    const picker = new EmojiPicker({ container, onSelect: () => {}, lang: "ru" });
    const anchor = document.createElement("button");
    container.appendChild(anchor);
    picker.show(anchor);

    const input = container.querySelector(".oxp-emoji-picker-input") as HTMLInputElement;
    expect(input.placeholder).toContain("эмодзи");
    picker.hide();
  });

  it("Russian no-results message", () => {
    const picker = new EmojiPicker({ container, onSelect: () => {}, lang: "ru" });
    const anchor = document.createElement("button");
    container.appendChild(anchor);
    picker.show(anchor);

    const searchInput = container.querySelector(".oxp-emoji-picker-input") as HTMLInputElement;
    searchInput.value = "xyzqwerty";
    searchInput.dispatchEvent(new Event("input"));

    const empty = container.querySelector(".oxp-emoji-picker-empty");
    expect(empty!.textContent).toBe("Эмодзи не найдены");
    picker.hide();
  });

  it("onHide fires when picker closes via Escape", () => {
    const onHide = vi.fn();
    const picker = new EmojiPicker({ container, onSelect: () => {}, onHide, lang: "en" });
    const anchor = document.createElement("button");
    container.appendChild(anchor);
    picker.show(anchor);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it("onHide fires on outside click", () => {
    const onHide = vi.fn();
    const picker = new EmojiPicker({ container, onSelect: () => {}, onHide, lang: "en" });
    const anchor = document.createElement("button");
    container.appendChild(anchor);
    picker.show(anchor);

    // Simulate outside click
    document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));

    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it("hide is idempotent — double hide does not double-fire onHide", () => {
    const onHide = vi.fn();
    const picker = new EmojiPicker({ container, onSelect: () => {}, onHide, lang: "en" });
    const anchor = document.createElement("button");
    container.appendChild(anchor);
    picker.show(anchor);
    picker.hide();
    picker.hide();

    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it("emoji buttons have aria-label with emoji name", () => {
    const picker = new EmojiPicker({ container, onSelect: () => {}, lang: "en" });
    const anchor = document.createElement("button");
    container.appendChild(anchor);
    picker.show(anchor);

    const firstEmoji = container.querySelector(".oxp-emoji-picker-emoji") as HTMLButtonElement;
    expect(firstEmoji.getAttribute("aria-label")).toBeTruthy();
    picker.hide();
  });
});
