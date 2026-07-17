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
});
