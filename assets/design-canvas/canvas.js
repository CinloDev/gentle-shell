// Gentle Design canvas: artboards side by side with pan, zoom, live reload and comments.
// Artboards run in iframes sandboxed with scripts only, so each one has an opaque
// origin; messages are trusted only by matching event.source to a known artboard.
(() => {
	"use strict";

	const config = JSON.parse(document.getElementById("gd-config").textContent);
	const base = String(config.base);
	const MIN_ZOOM = 0.05;
	const MAX_ZOOM = 4;
	const FIT_PADDING = 48;
	const LIMITS = { selector: 500, excerpt: 300, comment: 2000 };

	const $ = (id) => document.getElementById(id);
	const els = {
		title: $("gd-title"),
		design: $("gd-design"),
		zoomOut: $("gd-zoom-out"),
		zoomIn: $("gd-zoom-in"),
		zoomLevel: $("gd-zoom-level"),
		fit: $("gd-fit"),
		comment: $("gd-comment"),
		status: $("gd-status"),
		viewport: $("gd-viewport"),
		world: $("gd-world"),
		empty: $("gd-empty"),
		popover: $("gd-popover"),
		form: $("gd-popover-form"),
		target: $("gd-popover-target"),
		text: $("gd-popover-text"),
		message: $("gd-popover-message"),
		cancel: $("gd-popover-cancel"),
		send: $("gd-popover-send"),
	};

	const state = {
		slug: typeof config.slug === "string" ? config.slug : null,
		manifest: null,
		boards: [],
		zoom: 1,
		x: FIT_PADDING,
		y: FIT_PADDING,
		commenting: false,
		pick: null,
		closeTimer: 0,
	};

	function setStatus(text, isError) {
		els.status.textContent = text;
		els.status.classList.toggle("gd-error", Boolean(isError));
	}

	function fileUrl(slug, file) {
		return `${base}files/${encodeURIComponent(slug)}/${file.split("/").map(encodeURIComponent).join("/")}`;
	}

	async function getJson(path) {
		const response = await fetch(base + path, { headers: { Accept: "application/json" }, cache: "no-store" });
		let body = null;
		try { body = await response.json(); } catch { body = null; }
		if (!response.ok) {
			const reason = body && (body.reason || body.error);
			throw new Error(reason ? String(reason) : `HTTP ${response.status}`);
		}
		return body;
	}

	// ---- view transform -------------------------------------------------

	function clampZoom(value) {
		return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
	}

	function applyView() {
		els.world.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.zoom})`;
		els.zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
	}

	/** Zoom so the world point under (px, py) in viewport coordinates stays put. */
	function zoomAt(nextZoom, px, py) {
		const zoom = clampZoom(nextZoom);
		state.x = px - (px - state.x) * (zoom / state.zoom);
		state.y = py - (py - state.y) * (zoom / state.zoom);
		state.zoom = zoom;
		applyView();
		closePopover();
	}

	function zoomAtCenter(factor) {
		const rect = els.viewport.getBoundingClientRect();
		zoomAt(state.zoom * factor, rect.width / 2, rect.height / 2);
	}

	function panBy(dx, dy) {
		state.x += dx;
		state.y += dy;
		applyView();
		closePopover();
	}

	function fit() {
		const rect = els.viewport.getBoundingClientRect();
		const width = els.world.offsetWidth;
		const height = els.world.offsetHeight;
		if (!width || !height) return;
		const zoom = clampZoom(Math.min((rect.width - FIT_PADDING * 2) / width, (rect.height - FIT_PADDING * 2) / height, 1));
		state.zoom = zoom;
		state.x = (rect.width - width * zoom) / 2;
		state.y = Math.max(FIT_PADDING, (rect.height - height * zoom) / 2);
		applyView();
		closePopover();
	}

	function wheelPixels(delta, mode) {
		return mode === 1 ? delta * 16 : mode === 2 ? delta * 400 : delta;
	}

	/** Shared by native wheel events and wheel events forwarded from artboards. */
	function handleWheel(deltaX, deltaY, deltaMode, zooming, shift, clientX, clientY) {
		const dx = wheelPixels(deltaX, deltaMode);
		const dy = wheelPixels(deltaY, deltaMode);
		if (zooming) {
			const rect = els.viewport.getBoundingClientRect();
			const step = Math.max(-50, Math.min(50, dy));
			zoomAt(state.zoom * Math.exp(-step * 0.01), clientX - rect.left, clientY - rect.top);
		} else if (shift && dx === 0) {
			panBy(-dy, 0);
		} else {
			panBy(-dx, -dy);
		}
	}

	els.viewport.addEventListener("wheel", (event) => {
		event.preventDefault();
		handleWheel(event.deltaX, event.deltaY, event.deltaMode, event.ctrlKey || event.metaKey, event.shiftKey, event.clientX, event.clientY);
	}, { passive: false });

	let drag = null;
	els.viewport.addEventListener("pointerdown", (event) => {
		if (event.button !== 0 || (event.target !== els.viewport && event.target !== els.world && !event.target.closest(".gd-artboard-label"))) return;
		drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
		els.viewport.setPointerCapture(event.pointerId);
		els.viewport.classList.add("gd-panning");
	});
	els.viewport.addEventListener("pointermove", (event) => {
		if (!drag || drag.id !== event.pointerId) return;
		panBy(event.clientX - drag.x, event.clientY - drag.y);
		drag.x = event.clientX;
		drag.y = event.clientY;
	});
	const endDrag = (event) => {
		if (!drag || drag.id !== event.pointerId) return;
		drag = null;
		els.viewport.classList.remove("gd-panning");
	};
	els.viewport.addEventListener("pointerup", endDrag);
	els.viewport.addEventListener("pointercancel", endDrag);

	els.viewport.addEventListener("keydown", (event) => {
		if (event.target !== els.viewport) return;
		const step = event.shiftKey ? 200 : 50;
		const actions = {
			ArrowLeft: () => panBy(step, 0),
			ArrowRight: () => panBy(-step, 0),
			ArrowUp: () => panBy(0, step),
			ArrowDown: () => panBy(0, -step),
			"+": () => zoomAtCenter(1.25),
			"=": () => zoomAtCenter(1.25),
			"-": () => zoomAtCenter(0.8),
			"0": fit,
		};
		const action = actions[event.key];
		if (!action) return;
		event.preventDefault();
		action();
	});

	els.zoomIn.addEventListener("click", () => zoomAtCenter(1.25));
	els.zoomOut.addEventListener("click", () => zoomAtCenter(0.8));
	els.fit.addEventListener("click", fit);

	// ---- designs and artboards -------------------------------------------

	function showEmpty(text) {
		els.world.replaceChildren();
		state.boards = [];
		els.empty.textContent = text;
		els.empty.hidden = false;
	}

	function renderDesignOptions(designs) {
		const options = designs.map((design) => {
			const option = document.createElement("option");
			option.value = design.slug;
			option.textContent = design.valid ? design.title : `${design.slug} (invalid design.json)`;
			return option;
		});
		els.design.replaceChildren(...options);
		els.design.disabled = designs.length === 0;
		if (state.slug) els.design.value = state.slug;
	}

	async function refreshDesigns() {
		const { designs } = await getJson("api/designs");
		if (!state.slug && designs.length > 0) state.slug = designs[0].slug;
		renderDesignOptions(designs);
		return designs;
	}

	function sendMode(board) {
		board.frame.contentWindow?.postMessage({ type: "gd:mode", enabled: state.commenting }, "*");
	}

	function createBoard(slug, artboard) {
		const wrapper = document.createElement("section");
		wrapper.className = "gd-artboard";
		wrapper.setAttribute("aria-label", artboard.title);
		const label = document.createElement("div");
		label.className = "gd-artboard-label";
		const title = document.createElement("h2");
		title.className = "gd-artboard-title";
		title.textContent = artboard.title;
		label.append(title);
		if (artboard.tradeoff) {
			const tradeoff = document.createElement("p");
			tradeoff.className = "gd-artboard-tradeoff";
			tradeoff.textContent = artboard.tradeoff;
			label.append(tradeoff);
		}
		const frame = document.createElement("iframe");
		frame.className = "gd-artboard-frame";
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("referrerpolicy", "no-referrer");
		frame.title = `${artboard.title} artboard`;
		frame.style.width = `${artboard.width}px`;
		frame.style.height = `${artboard.height}px`;
		const board = { slug, artboard, frame, wrapper };
		frame.addEventListener("load", () => sendMode(board));
		frame.src = fileUrl(slug, artboard.file);
		wrapper.append(label, frame);
		return board;
	}

	async function loadManifest(slug, keepView) {
		let manifest;
		try {
			manifest = await getJson(`api/designs/${encodeURIComponent(slug)}`);
		} catch (error) {
			showEmpty(`Design "${slug}" cannot be shown: ${error.message}`);
			setStatus(`design.json for ${slug} is invalid`, true);
			return;
		}
		if (slug !== state.slug) return;
		closePopover();
		state.manifest = manifest;
		els.title.textContent = manifest.title;
		document.title = `${manifest.title} · Gentle Design`;
		history.replaceState(null, "", `${base}d/${encodeURIComponent(slug)}/`);
		if (manifest.artboards.length === 0) {
			showEmpty("This design has no artboards yet.");
			return;
		}
		els.empty.hidden = true;
		state.boards = manifest.artboards.map((artboard) => createBoard(slug, artboard));
		els.world.replaceChildren(...state.boards.map((board) => board.wrapper));
		setStatus("", false);
		if (!keepView) requestAnimationFrame(fit);
	}

	function reloadBoard(board) {
		board.frame.src = `${fileUrl(board.slug, board.artboard.file)}?v=${Date.now()}`;
	}

	els.design.addEventListener("change", () => {
		state.slug = els.design.value;
		loadManifest(state.slug, false);
	});

	async function start() {
		applyView();
		try {
			await refreshDesigns();
		} catch (error) {
			showEmpty(`Designs cannot be listed: ${error.message}`);
			return;
		}
		if (!state.slug) {
			showEmpty("No designs yet. Run /gentle:design with a brief to create one.");
			return;
		}
		await loadManifest(state.slug, false);
	}

	// ---- live reload -------------------------------------------------------

	function connectEvents() {
		const source = new EventSource(`${base}events`);
		source.addEventListener("open", () => {
			if (els.status.classList.contains("gd-error")) setStatus("", false);
		});
		source.addEventListener("error", () => setStatus("Live reload disconnected, retrying…", true));
		source.addEventListener("change", (event) => {
			let change;
			try { change = JSON.parse(event.data); } catch { return; }
			if (!change || typeof change.slug !== "string" || typeof change.file !== "string") return;
			if (change.file === "design.json") {
				refreshDesigns().then(() => {
					if (change.slug === state.slug) return loadManifest(state.slug, true);
					if (!state.manifest && state.slug) return loadManifest(state.slug, false);
					return undefined;
				}).catch(() => {});
				return;
			}
			if (change.slug !== state.slug) return;
			const matching = state.boards.filter((board) => board.artboard.file === change.file);
			// A shared asset (CSS, image, font) can affect every artboard of the design.
			const targets = matching.length > 0 ? matching : change.file.endsWith(".html") ? [] : state.boards;
			targets.forEach(reloadBoard);
		});
	}

	// ---- comments ----------------------------------------------------------

	function setCommenting(enabled) {
		state.commenting = enabled;
		els.comment.setAttribute("aria-pressed", String(enabled));
		els.world.classList.toggle("gd-commenting", enabled);
		state.boards.forEach(sendMode);
		setStatus(enabled ? "Comment mode: click an element in an artboard" : "", false);
		if (!enabled) closePopover();
	}

	els.comment.addEventListener("click", () => setCommenting(!state.commenting));

	function isFiniteNumber(value) {
		return typeof value === "number" && Number.isFinite(value);
	}

	function readPick(data) {
		if (typeof data.selector !== "string") return null;
		const selector = data.selector.trim();
		if (!selector || selector.length > LIMITS.selector) return null;
		const excerpt = typeof data.excerpt === "string" ? data.excerpt.slice(0, LIMITS.excerpt) : "";
		const rect = data.rect && typeof data.rect === "object" ? data.rect : {};
		const box = ["x", "y", "width", "height"].every((key) => isFiniteNumber(rect[key])) ? rect : { x: 0, y: 0, width: 0, height: 0 };
		return { selector, excerpt, rect: { x: box.x, y: box.y, width: box.width, height: box.height } };
	}

	function openPopover(board, pick) {
		clearTimeout(state.closeTimer);
		state.pick = { board, ...pick };
		els.target.textContent = `${board.artboard.file} · ${pick.selector}`;
		els.message.textContent = "";
		els.message.classList.remove("gd-error");
		els.send.disabled = false;
		els.popover.hidden = false;
		const frameRect = board.frame.getBoundingClientRect();
		const scale = frameRect.width / board.artboard.width || 1;
		const width = els.popover.offsetWidth;
		const height = els.popover.offsetHeight;
		let left = frameRect.left + pick.rect.x * scale;
		let top = frameRect.top + (pick.rect.y + pick.rect.height) * scale + 8;
		if (top + height > window.innerHeight - 12) top = frameRect.top + pick.rect.y * scale - height - 8;
		left = Math.min(Math.max(12, left), window.innerWidth - width - 12);
		top = Math.min(Math.max(12, top), window.innerHeight - height - 12);
		els.popover.style.left = `${left}px`;
		els.popover.style.top = `${top}px`;
		els.text.focus();
	}

	function closePopover() {
		if (els.popover.hidden) return;
		clearTimeout(state.closeTimer);
		const board = state.pick && state.pick.board;
		state.pick = null;
		els.popover.hidden = true;
		board?.frame.contentWindow?.postMessage({ type: "gd:clear" }, "*");
		if (els.popover.contains(document.activeElement) || document.activeElement === document.body) els.comment.focus();
	}

	els.cancel.addEventListener("click", closePopover);
	els.popover.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			closePopover();
		}
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && state.commenting && els.popover.hidden && event.target === document.body) setCommenting(false);
	});

	els.form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const pick = state.pick;
		if (!pick) return;
		const comment = els.text.value.trim();
		if (!comment || comment.length > LIMITS.comment) {
			els.message.textContent = `Write a comment of 1 to ${LIMITS.comment} characters.`;
			els.message.classList.add("gd-error");
			return;
		}
		els.send.disabled = true;
		els.message.classList.remove("gd-error");
		els.message.textContent = "Sending…";
		try {
			const response = await fetch(`${base}api/comments`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				cache: "no-store",
				body: JSON.stringify({ slug: pick.board.slug, file: pick.board.artboard.file, selector: pick.selector, excerpt: pick.excerpt, comment }),
			});
			if (response.status !== 202) {
				let reason = `HTTP ${response.status}`;
				try { reason = (await response.json()).error || reason; } catch { /* keep the status */ }
				throw new Error(reason);
			}
			if (state.pick !== pick) return;
			els.text.value = "";
			els.message.textContent = "Sent to the session";
			setStatus("Sent to the session", false);
			state.closeTimer = setTimeout(closePopover, 1200);
		} catch (error) {
			if (state.pick !== pick) return;
			els.send.disabled = false;
			els.message.textContent = `Not sent: ${error.message}`;
			els.message.classList.add("gd-error");
		}
	});

	window.addEventListener("message", (event) => {
		const board = state.boards.find((candidate) => candidate.frame.contentWindow === event.source);
		if (!board || !event.data || typeof event.data !== "object") return;
		const data = event.data;
		if (data.type === "gd:pick") {
			if (!state.commenting) return;
			const pick = readPick(data);
			if (pick) openPopover(board, pick);
		} else if (data.type === "gd:wheel") {
			if (![data.deltaX, data.deltaY, data.deltaMode, data.x, data.y].every(isFiniteNumber)) return;
			const frameRect = board.frame.getBoundingClientRect();
			const scale = frameRect.width / board.artboard.width || 1;
			handleWheel(data.deltaX, data.deltaY, data.deltaMode, data.zoom === true, data.shift === true, frameRect.left + data.x * scale, frameRect.top + data.y * scale);
		} else if (data.type === "gd:escape") {
			if (!els.popover.hidden) closePopover();
			else if (state.commenting) setCommenting(false);
		}
	});

	window.addEventListener("resize", closePopover);

	start();
	connectEvents();
})();
