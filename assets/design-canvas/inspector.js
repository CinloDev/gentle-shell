// Gentle Design artboard inspector, injected by the canvas server into every
// artboard. In comment mode it highlights the hovered element and reports the
// clicked one to the canvas; otherwise it only forwards canvas zoom and pan.
(() => {
	"use strict";

	if (window.parent === window) return;
	const MAX_SELECTOR = 500;
	const MAX_EXCERPT = 300;
	const MARK = "data-gd-inspector";
	let enabled = false;
	let hovered = null;
	let selected = null;

	function makeBox(color) {
		const box = document.createElement("div");
		box.setAttribute(MARK, "");
		box.setAttribute("aria-hidden", "true");
		Object.assign(box.style, {
			position: "fixed",
			pointerEvents: "none",
			zIndex: "2147483647",
			border: `2px solid ${color}`,
			background: "rgba(138, 180, 255, 0.12)",
			borderRadius: "2px",
			display: "none",
			margin: "0",
			padding: "0",
		});
		return box;
	}

	// Attached to <html>, not <body>, so body child positions (and selectors) stay unchanged.
	const hoverBox = makeBox("#8ab4ff");
	const selectedBox = makeBox("#ffd479");

	function place(box, element) {
		if (!element || !element.isConnected) {
			box.style.display = "none";
			return;
		}
		const rect = element.getBoundingClientRect();
		Object.assign(box.style, {
			display: "block",
			left: `${rect.left - 2}px`,
			top: `${rect.top - 2}px`,
			width: `${rect.width + 4}px`,
			height: `${rect.height + 4}px`,
		});
	}

	function refresh() {
		place(hoverBox, enabled ? hovered : null);
		place(selectedBox, selected);
	}

	function setEnabled(next) {
		enabled = next;
		if (enabled && !hoverBox.isConnected) document.documentElement.append(hoverBox, selectedBox);
		document.documentElement.style.cursor = enabled ? "crosshair" : "";
		if (!enabled) {
			hovered = null;
			selected = null;
		}
		refresh();
	}

	function isOwn(node) {
		return node instanceof Element && node.hasAttribute(MARK);
	}

	function targetOf(event) {
		const node = event.target;
		if (!(node instanceof Element) || isOwn(node)) return null;
		return node === document.documentElement ? document.body : node;
	}

	function hasUniqueId(element) {
		if (!element.id) return false;
		try {
			return document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1;
		} catch {
			return false;
		}
	}

	/** Stable selector: a unique id when there is one, else a tag:nth-of-type chain up to body. */
	function cssSelector(element) {
		if (!element || element === document.body || element === document.documentElement) return "body";
		const parts = [];
		let anchored = false;
		for (let node = element; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
			if (hasUniqueId(node)) {
				parts.unshift(`#${CSS.escape(node.id)}`);
				anchored = true;
				break;
			}
			const tag = node.localName;
			const parent = node.parentElement;
			const siblings = parent ? Array.from(parent.children).filter((child) => child.localName === tag) : [];
			parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
		}
		if (!anchored) parts.unshift("body");
		while (parts.join(" > ").length > MAX_SELECTOR && parts.length > 1) parts.shift();
		return parts.join(" > ").slice(0, MAX_SELECTOR);
	}

	function excerptOf(element) {
		const text = element.innerText || element.textContent || element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("title") || "";
		return text.replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT);
	}

	function post(message) {
		window.parent.postMessage(message, "*");
	}

	window.addEventListener("message", (event) => {
		if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
		if (event.data.type === "gd:mode") setEnabled(event.data.enabled === true);
		else if (event.data.type === "gd:clear") {
			selected = null;
			refresh();
		}
	});

	window.addEventListener("pointerover", (event) => {
		if (!enabled) return;
		hovered = targetOf(event);
		refresh();
	}, true);

	window.addEventListener("click", (event) => {
		if (!enabled) return;
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
		const element = targetOf(event);
		if (!element) return;
		selected = element;
		refresh();
		const rect = element.getBoundingClientRect();
		post({
			type: "gd:pick",
			selector: cssSelector(element),
			excerpt: excerptOf(element),
			rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
		});
	}, true);

	// While commenting, the artboard's own handlers, links and forms stay inert.
	for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "auxclick", "contextmenu", "submit"]) {
		window.addEventListener(type, (event) => {
			if (!enabled) return;
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
		}, true);
	}

	window.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && enabled) post({ type: "gd:escape" });
	}, true);

	function scrollableBy(element, dx, dy) {
		if (!element) return false;
		const root = element === document.scrollingElement;
		const style = getComputedStyle(element);
		const scrolls = (overflow) => root ? overflow !== "hidden" && overflow !== "clip" : overflow === "auto" || overflow === "scroll";
		if (dy !== 0 && scrolls(style.overflowY) && (dy > 0 ? element.scrollTop + element.clientHeight < element.scrollHeight - 1 : element.scrollTop > 0)) return true;
		if (dx !== 0 && scrolls(style.overflowX) && (dx > 0 ? element.scrollLeft + element.clientWidth < element.scrollWidth - 1 : element.scrollLeft > 0)) return true;
		return false;
	}

	function canScroll(node, dx, dy) {
		for (let element = node instanceof Element ? node : null; element; element = element.parentElement) {
			if (element !== document.scrollingElement && scrollableBy(element, dx, dy)) return true;
		}
		return scrollableBy(document.scrollingElement, dx, dy);
	}

	// Ctrl/Cmd + wheel (and trackpad pinch) always zooms the canvas; a plain wheel
	// pans the canvas only when the artboard itself cannot scroll that way.
	window.addEventListener("wheel", (event) => {
		const zoom = event.ctrlKey || event.metaKey;
		if (!zoom && canScroll(event.target, event.deltaX, event.deltaY)) return;
		event.preventDefault();
		post({ type: "gd:wheel", deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, zoom, shift: event.shiftKey, x: event.clientX, y: event.clientY });
	}, { passive: false, capture: true });

	window.addEventListener("scroll", refresh, true);
	window.addEventListener("resize", refresh);
})();
