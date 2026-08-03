/**
 * @oxpulse/chat-widget — Emoji picker (#127).
 *
 * Searchable, categorized emoji picker. Zero-third-party-dep — bundles a
 * curated emoji dataset (~180 emojis, 8 categories) in emoji-data.ts.
 *
 * Lifecycle:
 *   show(anchorEl)  — appends picker to container, positions below anchor
 *   hide()          — removes from DOM, restores focus
 *
 * A11y:
 *   role="dialog", search input focused on open, Arrow keys navigate,
 *   Escape hides + restores focus, Tab focus trap.
 *
 * Used from:
 *   - Composer: emoji button in the toolbar → inserts at cursor position
 *   - ReactionQuickBar: "more" button → opens full picker for any-emoji reaction
 */

import { EMOJI_CATEGORIES, searchEmojis, type EmojiEntry } from "../utils/emoji-data.js";
import { t, resolveLocale, type Locale } from "../utils/i18n.js";
import { computeFloatingPosition } from "../utils/floating-position.js";
import { useFloatingDismiss } from "../utils/floating-dismiss.js";

export interface EmojiPickerOptions {
  /** Container element to render the picker inside. */
  container: HTMLElement;
  /** Called when the user selects an emoji. */
  onSelect: (emoji: string) => void;
  /** Optional abort signal — when aborted, show() becomes a no-op. */
  signal?: AbortSignal;
  /** BCP-47 tag or an already-resolved Locale. */
  lang?: string;
  /** Called when the picker closes itself (Escape, outside click). */
  onHide?: () => void;
  /** Element to append the picker to (default: constructor container).
   *  Pass the ShadowRoot host element to escape overflow:hidden clip contexts
   *  — mirrors ReactionQuickBar's mountTo pattern (MAJOR-5). */
  mountTo?: HTMLElement;
}

const PICKER_WIDTH = 320;
const PICKER_HEIGHT = 280;
const EMOJIS_PER_ROW = 8;

export class EmojiPicker {
  #container: HTMLElement;
  #mountTo: HTMLElement | undefined;
  #onSelect: (emoji: string) => void;
  #onHide: (() => void) | undefined;
  #signal: AbortSignal | undefined;
  #lang: Locale;

  #pickerEl: HTMLElement | null = null;
  #anchorEl: HTMLElement | null = null;
  #restoreFocusEl: HTMLElement | null = null;
  #searchInput: HTMLInputElement | null = null;
  #gridEl: HTMLElement | null = null;
  #categoryNavEl: HTMLElement | null = null;
  #gridButtons: HTMLButtonElement[] = [];

  #dismissTeardown: (() => void) | null = null;
  #currentQuery = "";

  constructor(opts: EmojiPickerOptions) {
    this.#container = opts.container;
    this.#mountTo = opts.mountTo;
    this.#onSelect = opts.onSelect;
    this.#onHide = opts.onHide;
    this.#signal = opts.signal;
    this.#lang = resolveLocale(opts.lang);
  }

  /** Show the picker anchored below the given element. */
  show(anchorEl: HTMLElement, restoreFocusEl?: HTMLElement): void {
    if (this.#signal?.aborted) return;
    if (this.#pickerEl) this.#removePicker();

    this.#anchorEl = anchorEl;
    this.#restoreFocusEl = restoreFocusEl ?? anchorEl;

    this.#pickerEl = this.#buildPicker();
    const appendTarget = this.#mountTo ?? this.#container;
    appendTarget.appendChild(this.#pickerEl);
    this.#position(anchorEl);

    // Focus search input
    this.#searchInput?.focus();

    // #203: outside-pointerdown dismiss + Escape/Tab focus-trap + abort
    // wiring deduplicated into the shared helper (was a ~60-line clone of
    // ProductPicker). Behavior is identical.
    this.#dismissTeardown = useFloatingDismiss(this.#pickerEl, anchorEl, {
      onHide: () => this.hide(),
      getRestoreFocusEl: () => this.#restoreFocusEl,
      signal: this.#signal,
    });
  }

  /** Hide the picker without firing onSelect. */
  hide(): void {
    this.#removePicker();
  }

  get isOpen(): boolean {
    return this.#pickerEl !== null;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  #removePicker(): void {
    const wasOpen = this.#pickerEl !== null;
    this.#dismissTeardown?.();
    this.#dismissTeardown = null;
    if (this.#pickerEl?.parentNode) {
      this.#pickerEl.parentNode.removeChild(this.#pickerEl);
    }
    this.#pickerEl = null;
    this.#searchInput = null;
    this.#gridEl = null;
    this.#categoryNavEl = null;
    this.#gridButtons = [];
    this.#anchorEl = null;
    this.#restoreFocusEl = null;
    this.#currentQuery = "";
    if (wasOpen) this.#onHide?.();
  }

  #buildPicker(): HTMLElement {
    const el = document.createElement("div");
    el.className = "oxp-emoji-picker";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", t("emojiPickerAria", this.#lang));
    el.style.width = `${PICKER_WIDTH}px`;

    // Search bar
    const searchWrap = document.createElement("div");
    searchWrap.className = "oxp-emoji-picker-search";

    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.className = "oxp-emoji-picker-input";
    searchInput.placeholder = t("emojiPickerSearch", this.#lang);
    searchInput.setAttribute("aria-label", t("emojiPickerSearchAria", this.#lang));
    searchInput.addEventListener("input", () => {
      this.#currentQuery = searchInput.value;
      this.#renderGrid();
    });
    searchWrap.appendChild(searchInput);
    this.#searchInput = searchInput;

    // Category nav
    const nav = document.createElement("div");
    nav.className = "oxp-emoji-picker-nav";
    nav.setAttribute("role", "tablist");
    this.#categoryNavEl = nav;

    for (const cat of EMOJI_CATEGORIES) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "oxp-emoji-picker-tab";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", "false");
      tab.textContent = cat.emojis[0]!.char; // category icon = first emoji
      tab.title = this.#lang === "ru" ? cat.labelRu : cat.label;
      tab.addEventListener("click", () => {
        this.#currentQuery = "";
        searchInput.value = "";
        this.#renderGrid(cat.id);
        // Update tab selection
        nav.querySelectorAll(".oxp-emoji-picker-tab").forEach((t) => {
          t.setAttribute("aria-selected", "false");
        });
        tab.setAttribute("aria-selected", "true");
      });
      nav.appendChild(tab);
    }
    const firstTab = nav.querySelector(".oxp-emoji-picker-tab") as HTMLButtonElement;
    firstTab?.setAttribute("aria-selected", "true");

    // Grid
    const grid = document.createElement("div");
    grid.className = "oxp-emoji-picker-grid";
    grid.setAttribute("role", "gridbox");
    this.#gridEl = grid;

    el.appendChild(searchWrap);
    el.appendChild(nav);
    el.appendChild(grid);

    // Initial render — all emojis
    this.#renderGrid();

    return el;
  }

  #renderGrid(categoryId?: string): void {
    if (!this.#gridEl) return;
    this.#gridEl.replaceChildren();
    this.#gridButtons = [];

    let emojis: EmojiEntry[];
    if (this.#currentQuery) {
      emojis = searchEmojis(this.#currentQuery);
      // Hide category nav during search
      if (this.#categoryNavEl) this.#categoryNavEl.style.display = "none";
    } else {
      if (this.#categoryNavEl) this.#categoryNavEl.style.display = "";
      if (categoryId) {
        const cat = EMOJI_CATEGORIES.find((c) => c.id === categoryId);
        emojis = cat ? cat.emojis : [];
      } else {
        // Show all categories with labels
        this.#renderAllCategories();
        return;
      }
    }

    if (emojis.length === 0) {
      const empty = document.createElement("div");
      empty.className = "oxp-emoji-picker-empty";
      empty.textContent = t("emojiPickerNoResults", this.#lang);
      this.#gridEl.appendChild(empty);
      return;
    }

    this.#renderEmojiButtons(emojis);
  }

  #renderAllCategories(): void {
    if (!this.#gridEl) return;
    for (const cat of EMOJI_CATEGORIES) {
      const label = document.createElement("div");
      label.className = "oxp-emoji-picker-category-label";
      label.textContent = this.#lang === "ru" ? cat.labelRu : cat.label;
      this.#gridEl!.appendChild(label);
      this.#renderEmojiButtons(cat.emojis);
    }
  }

  #renderEmojiButtons(emojis: EmojiEntry[]): void {
    if (!this.#gridEl) return;
    for (const entry of emojis) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "oxp-emoji-picker-emoji";
      btn.textContent = entry.char;
      btn.title = entry.name;
      btn.setAttribute("aria-label", entry.name);
      btn.addEventListener("click", () => {
        this.#onSelect(entry.char);
        this.hide();
      });
      btn.addEventListener("keydown", (e: KeyboardEvent) => {
        const idx = this.#gridButtons.indexOf(btn);
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          this.#gridButtons[(idx + 1) % this.#gridButtons.length]?.focus();
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          this.#gridButtons[(idx - 1 + this.#gridButtons.length) % this.#gridButtons.length]?.focus();
        }
      });
      this.#gridEl!.appendChild(btn);
      this.#gridButtons.push(btn);
    }
  }

  #position(anchorEl: HTMLElement): void {
    if (!this.#pickerEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const isMountedOutside = this.#mountTo !== undefined && this.#mountTo !== this.#container;
    const containerRect = isMountedOutside ? undefined : this.#container.getBoundingClientRect();
    const pos = computeFloatingPosition({
      anchorRect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      elemWidth: PICKER_WIDTH,
      elemHeight: PICKER_HEIGHT,
      mountedOutside: isMountedOutside,
      containerRect: containerRect
        ? { top: containerRect.top, left: containerRect.left, width: this.#container.offsetWidth, height: this.#container.offsetHeight }
        : undefined,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      margin: 8,
      gap: 4,
    });
    this.#pickerEl.style.position = pos.position;
    this.#pickerEl.style.top = `${pos.top}px`;
    if (pos.left !== undefined) this.#pickerEl.style.left = `${pos.left}px`;
    this.#pickerEl.style.zIndex = "20";
  }
}
