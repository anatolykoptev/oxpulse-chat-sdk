/**
 * @oxpulse/chat-widget — Product picker (seller catalog).
 *
 * Searchable dropdown listing the seller's product catalog. On select,
 * calls `onSelect(productRef, productMeta)` which the Composer wires to
 * `setProductCard()`.
 *
 * Lifecycle (mirrors EmojiPicker):
 *   show(anchorEl)  — appends picker to container, positions below anchor
 *   hide()          — removes from DOM, restores focus
 *
 * A11y:
 *   role="dialog", search input focused on open, Arrow keys navigate,
 *   Escape hides + restores focus, Tab focus trap.
 *
 * Used from:
 *   - Composer: product button in the toolbar → opens picker →
 *     onSelect → composer.setProductCard(ref, meta) → existing chip → send
 */

import { t, resolveLocale, type Locale } from "../utils/i18n.js";
import { computeFloatingPosition } from "../utils/floating-position.js";
import type { ProductMeta } from "../types.js";
import type { SDKCatalogClient, CatalogProduct } from "@oxpulse/chat-sdk";

export interface ProductPickerOptions {
  /** Container element to render the picker inside. */
  container: HTMLElement;
  /** Catalog client for fetching the seller's products. */
  client: SDKCatalogClient;
  /** Called when the user selects a product. */
  onSelect: (productRef: string, productMeta: ProductMeta) => void;
  /** Optional abort signal — when aborted, show() becomes a no-op. */
  signal?: AbortSignal;
  /** BCP-47 tag or an already-resolved Locale. */
  lang?: string;
  /** Called when the picker closes itself (Escape, outside click). */
  onHide?: () => void;
  /** Element to append the picker to (default: constructor container).
   *  Pass the ShadowRoot host element to escape overflow:hidden clip contexts
   *  — mirrors EmojiPicker's mountTo pattern (MAJOR-5). */
  mountTo?: HTMLElement;
}

const PICKER_WIDTH = 320;
const PICKER_HEIGHT = 320;
const PRODUCTS_PER_PAGE = 50;

export class ProductPicker {
  #container: HTMLElement;
  #mountTo: HTMLElement | undefined;
  #client: SDKCatalogClient;
  #onSelect: (productRef: string, productMeta: ProductMeta) => void;
  #onHide: (() => void) | undefined;
  #signal: AbortSignal | undefined;
  #lang: Locale;

  #pickerEl: HTMLElement | null = null;
  #anchorEl: HTMLElement | null = null;
  #restoreFocusEl: HTMLElement | null = null;
  #searchInput: HTMLInputElement | null = null;
  #listEl: HTMLElement | null = null;
  #itemButtons: HTMLButtonElement[] = [];

  #outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  #keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  #abortListener: (() => void) | null = null;
  #currentQuery = "";

  // Cached products from the catalog API.
  #allProducts: CatalogProduct[] = [];
  #filteredProducts: CatalogProduct[] = [];
  #loading = false;
  #loadError = false;

  constructor(opts: ProductPickerOptions) {
    this.#container = opts.container;
    this.#mountTo = opts.mountTo;
    this.#client = opts.client;
    this.#onSelect = opts.onSelect;
    this.#onHide = opts.onHide;
    this.#signal = opts.signal;
    this.#lang = resolveLocale(opts.lang);
  }

  /** Show the picker anchored below the given element. */
  async show(anchorEl: HTMLElement, restoreFocusEl?: HTMLElement): Promise<void> {
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

    // Load products from catalog API
    await this.#loadProducts();

    // Outside dismissal
    this.#outsideClickHandler = (e: MouseEvent) => {
      if (
        this.#pickerEl &&
        !this.#pickerEl.contains(e.target as Node) &&
        e.target !== anchorEl &&
        !anchorEl.contains(e.target as Node)
      ) {
        this.hide();
      }
    };
    document.addEventListener("pointerdown", this.#outsideClickHandler, true);

    // Escape + Tab trap
    this.#keydownHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        const restore = this.#restoreFocusEl;
        this.hide();
        queueMicrotask(() => restore?.focus());
      } else if (e.key === "Tab" && this.#pickerEl) {
        const focusable = this.#pickerEl.querySelectorAll<HTMLElement>(
          "input, button:not([disabled])",
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", this.#keydownHandler);

    if (this.#signal) {
      this.#abortListener = () => this.hide();
      this.#signal.addEventListener("abort", this.#abortListener, { once: true });
    }
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
    if (this.#outsideClickHandler) {
      document.removeEventListener("pointerdown", this.#outsideClickHandler, true);
      this.#outsideClickHandler = null;
    }
    if (this.#keydownHandler) {
      document.removeEventListener("keydown", this.#keydownHandler);
      this.#keydownHandler = null;
    }
    if (this.#abortListener && this.#signal) {
      this.#signal.removeEventListener("abort", this.#abortListener);
      this.#abortListener = null;
    }
    if (this.#pickerEl?.parentNode) {
      this.#pickerEl.parentNode.removeChild(this.#pickerEl);
    }
    this.#pickerEl = null;
    this.#searchInput = null;
    this.#listEl = null;
    this.#itemButtons = [];
    this.#anchorEl = null;
    this.#restoreFocusEl = null;
    this.#currentQuery = "";
    if (wasOpen) this.#onHide?.();
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

  #buildPicker(): HTMLElement {
    const el = document.createElement("div");
    el.className = "oxp-product-picker";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Product catalog");
    el.style.width = `${PICKER_WIDTH}px`;
    el.style.maxHeight = `${PICKER_HEIGHT}px`;

    // Search bar
    const searchWrap = document.createElement("div");
    searchWrap.className = "oxp-product-picker-search";

    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.className = "oxp-product-picker-input";
    searchInput.placeholder = "Search products…";
    searchInput.setAttribute("aria-label", "Search products");
    searchInput.addEventListener("input", () => {
      this.#currentQuery = searchInput.value.toLowerCase();
      this.#renderList();
    });
    searchWrap.appendChild(searchInput);
    this.#searchInput = searchInput;

    // Product list
    const listEl = document.createElement("div");
    listEl.className = "oxp-product-picker-list";
    listEl.setAttribute("role", "listbox");
    listEl.setAttribute("aria-label", "Product list");
    this.#listEl = listEl;

    el.appendChild(searchWrap);
    el.appendChild(listEl);
    return el;
  }

  async #loadProducts(): Promise<void> {
    if (this.#loading || this.#allProducts.length > 0) return;
    this.#loading = true;
    this.#loadError = false;
    this.#renderList();

    try {
      this.#allProducts = await this.#client.listProducts({ limit: PRODUCTS_PER_PAGE });
      this.#filteredProducts = this.#allProducts;
    } catch (err) {
      console.error("[product-picker] failed to load catalog:", err);
      this.#loadError = true;
      this.#allProducts = [];
      this.#filteredProducts = [];
    } finally {
      this.#loading = false;
      this.#renderList();
    }
  }

  #renderList(): void {
    if (!this.#listEl) return;

    // Filter by search query
    if (this.#currentQuery) {
      this.#filteredProducts = this.#allProducts.filter((p) => {
        const title = p.productMeta.title.toLowerCase();
        const ref = p.productRef.toLowerCase();
        return title.includes(this.#currentQuery) || ref.includes(this.#currentQuery);
      });
    } else {
      this.#filteredProducts = this.#allProducts;
    }

    // Clear
    this.#listEl.innerHTML = "";
    this.#itemButtons = [];

    if (this.#loading) {
      const loading = document.createElement("div");
      loading.className = "oxp-product-picker-loading";
      loading.textContent = "Loading…";
      loading.setAttribute("aria-live", "polite");
      this.#listEl.appendChild(loading);
      return;
    }

    if (this.#loadError) {
      const error = document.createElement("div");
      error.className = "oxp-product-picker-error";
      error.textContent = "Failed to load catalog";
      this.#listEl.appendChild(error);
      return;
    }

    if (this.#filteredProducts.length === 0) {
      const empty = document.createElement("div");
      empty.className = "oxp-product-picker-empty";
      empty.textContent =
        this.#allProducts.length === 0 ? "No products in catalog" : "No matches";
      this.#listEl.appendChild(empty);
      return;
    }

    // Render product items
    for (const product of this.#filteredProducts) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "oxp-product-picker-item";
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-label", product.productMeta.title);

      const titleEl = document.createElement("span");
      titleEl.className = "oxp-product-picker-item-title";
      titleEl.textContent = product.productMeta.title;
      btn.appendChild(titleEl);

      const priceEl = document.createElement("span");
      priceEl.className = "oxp-product-picker-item-price";
      priceEl.textContent = `${product.productMeta.price} ${product.productMeta.currency}`;
      btn.appendChild(priceEl);

      btn.addEventListener("click", () => {
        this.#onSelect(product.productRef, product.productMeta);
        this.hide();
      });

      // Arrow key navigation
      btn.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          const idx = this.#itemButtons.indexOf(btn);
          if (idx < this.#itemButtons.length - 1) {
            this.#itemButtons[idx + 1]?.focus();
          }
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          const idx = this.#itemButtons.indexOf(btn);
          if (idx > 0) {
            this.#itemButtons[idx - 1]?.focus();
          }
        }
      });

      this.#listEl.appendChild(btn);
      this.#itemButtons.push(btn);
    }
  }
}
