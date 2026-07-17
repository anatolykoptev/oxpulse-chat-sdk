import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProductPicker } from "../ui/product-picker.js";
import type { SDKCatalogClient, CatalogProduct } from "@oxpulse/chat-sdk";

const validMeta = { title: "Widget", price: 19.99, currency: "USD", imageUrl: "", productUrl: "" };

function makeProduct(ref: string, title: string): CatalogProduct {
	return {
		productRef: ref,
		productMeta: { ...validMeta, title },
		createdAt: "2026-07-16T00:00:00Z",
		updatedAt: "2026-07-16T00:00:00Z",
		archivedAt: null,
	};
}

function makeMockClient(products: CatalogProduct[]): SDKCatalogClient {
	// #195: listProducts now returns { products, hasMore, nextCursor }.
	return {
		listProducts: vi.fn().mockResolvedValue({ products, hasMore: false }),
	} as unknown as SDKCatalogClient;
}

describe("ProductPicker", () => {
	let container: HTMLElement;
	let anchor: HTMLElement;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		anchor = document.createElement("button");
		container.appendChild(anchor);
	});

	afterEach(() => {
		container.remove();
	});

	it("starts closed", () => {
		const picker = new ProductPicker({
			container,
			client: makeMockClient([]),
			onSelect: () => {},
		});
		expect(picker.isOpen).toBe(false);
	});

	it("opens and loads products from catalog client", async () => {
		const products = [makeProduct("sku-1", "Widget"), makeProduct("sku-2", "Gadget")];
		const client = makeMockClient(products);
		const picker = new ProductPicker({
			container,
			client,
			onSelect: () => {},
		});

		await picker.show(anchor);

		expect(picker.isOpen).toBe(true);
		expect(client.listProducts).toHaveBeenCalledWith({ limit: 50 });

		// Should render 2 product items
		const items = container.querySelectorAll(".oxp-product-picker-item");
		expect(items.length).toBe(2);

		picker.hide();
		expect(picker.isOpen).toBe(false);
	});

	it("calls onSelect with productRef and productMeta on click", async () => {
		const products = [makeProduct("sku-1", "Widget")];
		const client = makeMockClient(products);
		const onSelect = vi.fn();
		const picker = new ProductPicker({
			container,
			client,
			onSelect,
		});

		await picker.show(anchor);

		const item = container.querySelector(".oxp-product-picker-item") as HTMLButtonElement;
		expect(item).toBeTruthy();
		item.click();

		expect(onSelect).toHaveBeenCalledWith("sku-1", products[0].productMeta);
		expect(picker.isOpen).toBe(false); // auto-hides after select
	});

	it("filters products by search query", async () => {
		const products = [makeProduct("sku-1", "Widget"), makeProduct("sku-2", "Gadget")];
		const client = makeMockClient(products);
		const picker = new ProductPicker({
			container,
			client,
			onSelect: () => {},
		});

		await picker.show(anchor);

		const searchInput = container.querySelector(".oxp-product-picker-input") as HTMLInputElement;
		searchInput.value = "wid";
		searchInput.dispatchEvent(new Event("input"));

		const items = container.querySelectorAll(".oxp-product-picker-item");
		expect(items.length).toBe(1);
		expect(items[0].textContent).toContain("Widget");

		picker.hide();
	});

	it("shows empty state when catalog has no products", async () => {
		const client = makeMockClient([]);
		const picker = new ProductPicker({
			container,
			client,
			onSelect: () => {},
		});

		await picker.show(anchor);

		const empty = container.querySelector(".oxp-product-picker-empty");
		expect(empty).toBeTruthy();
		expect(empty?.textContent).toBe("No products in catalog");

		picker.hide();
	});

	it("shows error state when catalog API fails", async () => {
		const client = {
			listProducts: vi.fn().mockRejectedValue(new Error("network")),
		} as unknown as SDKCatalogClient;
		const picker = new ProductPicker({
			container,
			client,
			onSelect: () => {},
		});

		await picker.show(anchor);

		const error = container.querySelector(".oxp-product-picker-error");
		expect(error).toBeTruthy();
		expect(error?.textContent).toContain("Failed to load catalog");

		picker.hide();
	});

	it("hides on Escape key", async () => {
		const products = [makeProduct("sku-1", "Widget")];
		const client = makeMockClient(products);
		const picker = new ProductPicker({
			container,
			client,
			onSelect: () => {},
		});

		await picker.show(anchor);
		expect(picker.isOpen).toBe(true);

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(picker.isOpen).toBe(false);
	});

	it("hides on outside click", async () => {
		const products = [makeProduct("sku-1", "Widget")];
		const client = makeMockClient(products);
		const picker = new ProductPicker({
			container,
			client,
			onSelect: () => {},
		});

		await picker.show(anchor);
		expect(picker.isOpen).toBe(true);

		// Click outside the picker
		const outside = document.createElement("div");
		document.body.appendChild(outside);
		outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		expect(picker.isOpen).toBe(false);
		outside.remove();
	});

	it("does not open when signal is already aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		const client = makeMockClient([]);
		const picker = new ProductPicker({
			container,
			client,
			onSelect: () => {},
			signal: ac.signal,
		});

		await picker.show(anchor);
		expect(picker.isOpen).toBe(false);
	});

	// ── #199: refetch on each show (no stale cache) ─────────────────────────────

	it("#199 refetches products on every show (no length>0 short-circuit)", async () => {
		const products = [makeProduct("sku-1", "Widget")];
		const client = makeMockClient(products);
		const picker = new ProductPicker({
			container,
			client,
			onSelect: () => {},
		});

		await picker.show(anchor);
		picker.hide();
		await picker.show(anchor);
		picker.hide();

		expect((client.listProducts as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
	});

	// ── #200: aria-live on the stable list container (all states announce) ──────

	it("#200 aria-live=polite is set on the list container in the error state", async () => {
		const client = {
			listProducts: vi.fn().mockRejectedValue(new Error("network")),
		} as unknown as SDKCatalogClient;
		const picker = new ProductPicker({ container, client, onSelect: () => {} });

		await picker.show(anchor);

		const list = container.querySelector(".oxp-product-picker-list") as HTMLElement;
		expect(list).toBeTruthy();
		expect(list.getAttribute("aria-live")).toBe("polite");
		// Error branch rendered inside the live region.
		const error = list.querySelector(".oxp-product-picker-error");
		expect(error).toBeTruthy();

		picker.hide();
	});

	it("#200 aria-live=polite is set on the list container in the empty state", async () => {
		const client = makeMockClient([]);
		const picker = new ProductPicker({ container, client, onSelect: () => {} });

		await picker.show(anchor);

		const list = container.querySelector(".oxp-product-picker-list") as HTMLElement;
		expect(list.getAttribute("aria-live")).toBe("polite");
		const empty = list.querySelector(".oxp-product-picker-empty");
		expect(empty).toBeTruthy();

		picker.hide();
	});

	// ── #205: fallback rendered, never literal "undefined" ──────────────────────

	it("#205 renders localized fallback title when productMeta.title is empty", async () => {
		const product: CatalogProduct = {
			productRef: "sku-blank",
			productMeta: { ...validMeta, title: "" },
			createdAt: "2026-07-16T00:00:00Z",
			updatedAt: "2026-07-16T00:00:00Z",
			archivedAt: null,
		};
		const client = makeMockClient([product]);
		const picker = new ProductPicker({ container, client, onSelect: () => {} });

		await picker.show(anchor);

		const item = container.querySelector(".oxp-product-picker-item") as HTMLButtonElement;
		expect(item).toBeTruthy();
		// Fallback key (en) — never the literal string "undefined".
		expect(item.textContent).toContain("Untitled product");
		expect(item.textContent).not.toContain("undefined");

		picker.hide();
	});

	it("#205 omits the price span when price/currency are absent (no 'undefined')", async () => {
		const product: CatalogProduct = {
			productRef: "sku-noprice",
			// Malformed meta: price + currency missing entirely.
			productMeta: { title: "No Price", price: undefined as unknown as number, currency: "" } as CatalogProduct["productMeta"],
			createdAt: "2026-07-16T00:00:00Z",
			updatedAt: "2026-07-16T00:00:00Z",
			archivedAt: null,
		};
		const client = makeMockClient([product]);
		const picker = new ProductPicker({ container, client, onSelect: () => {} });

		await picker.show(anchor);

		const item = container.querySelector(".oxp-product-picker-item") as HTMLButtonElement;
		expect(item).toBeTruthy();
		expect(item.textContent).toContain("No Price");
		expect(item.textContent).not.toContain("undefined");
		// No price span rendered.
		expect(item.querySelector(".oxp-product-picker-item-price")).toBeNull();

		picker.hide();
	});

	// ── #207: numeric price is locale-formatted, not raw "19.99 USD" ────────────

	it("#207 formats numeric price via Intl.NumberFormat (currency style)", async () => {
		const product = makeProduct("sku-1", "Widget");
		const client = makeMockClient([product]);
		const picker = new ProductPicker({ container, client, onSelect: () => {} });

		await picker.show(anchor);

		const priceEl = container.querySelector(".oxp-product-picker-item-price") as HTMLElement;
		expect(priceEl).toBeTruthy();
		// en locale + USD → "$19.99" (Intl currency formatting), NOT "19.99 USD".
		expect(priceEl.textContent).not.toBe("19.99 USD");
		expect(priceEl.textContent).toMatch(/19\.99/);

		picker.hide();
	});

	// ── #204: arrow-key nav from the search input ───────────────────────────────

	it("#204 ArrowDown from the search input focuses the first item", async () => {
		const products = [makeProduct("sku-1", "Widget"), makeProduct("sku-2", "Gadget")];
		const client = makeMockClient(products);
		const picker = new ProductPicker({ container, client, onSelect: () => {} });

		await picker.show(anchor);

		const searchInput = container.querySelector(".oxp-product-picker-input") as HTMLInputElement;
		expect(searchInput).toBeTruthy();
		searchInput.focus();
		expect(document.activeElement).toBe(searchInput);

		searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

		const items = container.querySelectorAll(".oxp-product-picker-item");
		expect(items.length).toBe(2);
		expect(document.activeElement).toBe(items[0]);

		picker.hide();
	});

	it("#204 ArrowUp from the search input focuses the last item", async () => {
		const products = [makeProduct("sku-1", "Widget"), makeProduct("sku-2", "Gadget")];
		const client = makeMockClient(products);
		const picker = new ProductPicker({ container, client, onSelect: () => {} });

		await picker.show(anchor);

		const searchInput = container.querySelector(".oxp-product-picker-input") as HTMLInputElement;
		searchInput.focus();
		searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

		const items = container.querySelectorAll(".oxp-product-picker-item");
		expect(document.activeElement).toBe(items[items.length - 1]);

		picker.hide();
	});
});
