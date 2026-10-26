import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatDesignComment, startDesignCanvasServer, type DesignComment } from "../lib/design-canvas-server.ts";

const TOKEN = "test-token-0123456789abcdef";
const ASSET_DIR = fileURLToPath(new URL("../assets/design-canvas/", import.meta.url));

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
type Options = { method?: string; headers?: Record<string, string>; body?: string; host?: string | null };

function rawRequest(port: number, path: string, options: Options = {}): Promise<Reply> {
	const headers: Record<string, string> = { ...(options.headers ?? {}) };
	if (options.host !== null) headers.Host = options.host ?? `127.0.0.1:${port}`;
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers, setHost: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
			res.on("error", reject);
		});
		req.on("error", reject);
		if (options.body !== undefined) req.write(options.body);
		req.end();
	});
}

function manifest(title: string, files: string[]) {
	return JSON.stringify({
		title,
		brief: `${title} brief`,
		artboards: files.map((file, index) => ({ file, title: `Direction ${index + 1}`, tradeoff: `Tradeoff ${index + 1}`, width: 1280, height: 800 })),
	});
}

/** A `mktemp -d` style directory removed when the test ends. */
function scratch(t: TestContext, prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function fixture(t: TestContext) {
	const root = scratch(t, "gentle-design-canvas-");
	const outside = scratch(t, "gentle-design-outside-");
	writeFileSync(join(outside, "secret.html"), "<p>secret</p>");
	const alpha = join(root, "alpha");
	mkdirSync(join(alpha, "sub"), { recursive: true });
	writeFileSync(join(alpha, "design.json"), manifest("Alpha", ["01-hero.html", "02-bare.html"]));
	writeFileSync(join(alpha, "01-hero.html"), "<!doctype html><html><body><h1>Hero</h1></body></html>");
	writeFileSync(join(alpha, "02-bare.html"), "<h1>Bare</h1>");
	writeFileSync(join(alpha, "styles.css"), "h1{color:red}");
	writeFileSync(join(alpha, "logo.svg"), "<svg></svg>");
	writeFileSync(join(alpha, "notes.txt"), "not served");
	writeFileSync(join(alpha, "sub", "inner.html"), "<p>inner</p>");
	symlinkSync(join(outside, "secret.html"), join(alpha, "escape.html"));
	symlinkSync(outside, join(alpha, "linkdir"));
	symlinkSync(join(alpha, "01-hero.html"), join(alpha, "alias.html"));
	mkdirSync(join(root, "beta"));
	writeFileSync(join(root, "beta", "design.json"), manifest("Beta", ["01-a.html"]));
	writeFileSync(join(root, "beta", "01-a.html"), "<p>beta</p>");
	mkdirSync(join(root, "broken"));
	writeFileSync(join(root, "broken", "design.json"), "{ not json");
	mkdirSync(join(root, "Not_A_Slug"));
	writeFileSync(join(root, "Not_A_Slug", "design.json"), manifest("Ignored", ["01-a.html"]));
	utimesSync(join(alpha, "design.json"), 3000, 3000);
	utimesSync(join(root, "broken", "design.json"), 2000, 2000);
	utimesSync(join(root, "beta", "design.json"), 1000, 1000);
	return { root, outside };
}

async function start(t: TestContext, extra: { initialSlug?: string } = {}) {
	const { root } = fixture(t);
	const comments: DesignComment[] = [];
	const server = await startDesignCanvasServer({ designRoot: root, onComment: (comment) => { comments.push(comment); }, randomToken: () => TOKEN, ...extra });
	t.after(() => server.close());
	return { server, root, comments, port: server.port, base: `/${TOKEN}/` };
}

test("start returns a loopback URL with a random base64url token by default", async (t) => {
	const { root } = fixture(t);
	const server = await startDesignCanvasServer({ designRoot: root, onComment: () => {} });
	t.after(() => server.close());
	assert.match(server.token, /^[A-Za-z0-9_-]{32}$/);
	assert.equal(server.url, `http://127.0.0.1:${server.port}/${server.token}/`);
	const withSlug = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, initialSlug: "alpha" });
	t.after(() => withSlug.close());
	assert.notEqual(withSlug.token, server.token);
	assert.equal(withSlug.url, `http://127.0.0.1:${withSlug.port}/${withSlug.token}/d/alpha/`);
	await assert.rejects(startDesignCanvasServer({ designRoot: root, onComment: () => {}, initialSlug: "../x" }));
	await assert.rejects(startDesignCanvasServer({ designRoot: "relative/design", onComment: () => {} }));
});

test("every route needs the token and anything else is 404", async (t) => {
	const { port } = await start(t);
	for (const path of ["/", "/api/designs", "/wrong-token/", `/${TOKEN.slice(0, -1)}/`, `/${TOKEN}x/api/designs`, `/${TOKEN}/unknown`]) {
		assert.equal((await rawRequest(port, path)).status, 404, path);
	}
	assert.equal((await rawRequest(port, `/${TOKEN}/`)).status, 200);
});

test("a foreign or missing Host header is rejected", async (t) => {
	const { port, base } = await start(t);
	assert.equal((await rawRequest(port, base, { host: `evil.example:${port}` })).status, 421);
	assert.equal((await rawRequest(port, base, { host: `127.0.0.1:${port + 1}` })).status, 421);
	assert.equal((await rawRequest(port, base, { host: "127.0.0.1" })).status, 421);
	assert.equal((await rawRequest(port, base, { host: null })).status, 421);
	assert.equal((await rawRequest(port, base, { host: `localhost:${port}` })).status, 200);
});

test("a GET carrying a foreign Origin is rejected", async (t) => {
	const { port, base } = await start(t);
	assert.equal((await rawRequest(port, `${base}api/designs`, { headers: { Origin: "http://evil.example" } })).status, 403);
	assert.equal((await rawRequest(port, `${base}api/designs`, { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
});

test("sandboxed artboards load their subresources with Origin null, but nothing else accepts it", async (t) => {
	// Chrome sends `Origin: null` for script requests from an opaque-origin (sandboxed) artboard.
	const { port, base } = await start(t);
	const nullOrigin = { headers: { Origin: "null" } };
	for (const path of ["assets/inspector.js", "files/alpha/01-hero.html", "files/alpha/styles.css", "files/alpha/logo.svg"]) {
		assert.equal((await rawRequest(port, `${base}${path}`, nullOrigin)).status, 200, path);
	}
	for (const path of ["", "d/alpha/", "assets/canvas.js", "assets/canvas.css", "api/designs", "api/designs/alpha", "events"]) {
		assert.equal((await rawRequest(port, `${base}${path}`, nullOrigin)).status, 403, path);
	}
	assert.equal((await rawRequest(port, `${base}assets/inspector.js`, { headers: { Origin: "http://evil.example" } })).status, 403);
	assert.equal((await rawRequest(port, `${base}files/alpha/01-hero.html`, { headers: { Origin: "http://evil.example" } })).status, 403);
});

test("the canvas page carries a strict CSP and a JSON config, never inline code", async (t) => {
	const { port, base } = await start(t);
	const page = await rawRequest(port, base);
	assert.equal(page.status, 200);
	assert.match(String(page.headers["content-type"]), /^text\/html/);
	assert.equal(page.headers["cache-control"], "no-store");
	assert.equal(page.headers["x-content-type-options"], "nosniff");
	const csp = String(page.headers["content-security-policy"]);
	for (const directive of ["default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(directive), directive);
	assert.ok(!csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"));
	const config = /<script id="gd-config" type="application\/json">([^<]*)<\/script>/.exec(page.body);
	assert.ok(config, "config script present");
	assert.deepEqual(JSON.parse(config[1]), { base, slug: null });
	assert.ok(page.body.includes(`src="${base}assets/canvas.js"`));
	const slugPage = await rawRequest(port, `${base}d/alpha/`);
	assert.equal(slugPage.status, 200);
	assert.deepEqual(JSON.parse(/<script id="gd-config" type="application\/json">([^<]*)<\/script>/.exec(slugPage.body)![1]), { base, slug: "alpha" });
	assert.equal((await rawRequest(port, `${base}d/Bad_Slug/`)).status, 404);
	assert.equal((await rawRequest(port, `${base}d/alpha/extra`)).status, 404);
	assert.equal((await rawRequest(port, base, { method: "POST" })).status, 405);
});

test("only the fixed canvas assets are served", async (t) => {
	const { port, base } = await start(t);
	const js = await rawRequest(port, `${base}assets/canvas.js`);
	assert.equal(js.status, 200);
	assert.match(String(js.headers["content-type"]), /^text\/javascript/);
	assert.equal(js.body, readFileSync(join(ASSET_DIR, "canvas.js"), "utf8"));
	assert.match(String((await rawRequest(port, `${base}assets/canvas.css`)).headers["content-type"]), /^text\/css/);
	assert.equal((await rawRequest(port, `${base}assets/inspector.js`)).status, 200);
	for (const name of ["index.html", "missing.js", "..%2Fpackage.json", "%2e%2e", "canvas.js/x"]) {
		assert.equal((await rawRequest(port, `${base}assets/${name}`)).status, 404, name);
	}
});

test("designs are listed from design.json manifests, most recent first", async (t) => {
	const { port, base } = await start(t);
	const reply = await rawRequest(port, `${base}api/designs`);
	assert.equal(reply.status, 200);
	assert.match(String(reply.headers["content-type"]), /^application\/json/);
	const designs = JSON.parse(reply.body).designs;
	assert.deepEqual(designs.map((design: { slug: string }) => design.slug), ["alpha", "broken", "beta"]);
	assert.deepEqual(designs[0], { slug: "alpha", title: "Alpha", mtime: 3000000, valid: true });
	assert.deepEqual(designs[1], { slug: "broken", title: "broken", mtime: 2000000, valid: false });
});

test("a manifest is returned normalized, and invalid slugs or manifests are refused", async (t) => {
	const { port, base, root } = await start(t);
	const reply = await rawRequest(port, `${base}api/designs/alpha`);
	assert.equal(reply.status, 200);
	assert.deepEqual(JSON.parse(reply.body), {
		slug: "alpha",
		title: "Alpha",
		brief: "Alpha brief",
		artboards: [
			{ file: "01-hero.html", title: "Direction 1", tradeoff: "Tradeoff 1", width: 1280, height: 800 },
			{ file: "02-bare.html", title: "Direction 2", tradeoff: "Tradeoff 2", width: 1280, height: 800 },
		],
	});
	assert.equal((await rawRequest(port, `${base}api/designs/Alpha`)).status, 404);
	assert.equal((await rawRequest(port, `${base}api/designs/missing`)).status, 404);
	const broken = await rawRequest(port, `${base}api/designs/broken`);
	assert.equal(broken.status, 422);
	assert.match(JSON.parse(broken.body).reason, /JSON/);
	mkdirSync(join(root, "gamma"));
	writeFileSync(join(root, "gamma", "design.json"), JSON.stringify({ title: "G", artboards: [{ file: "../beta/01-a.html", title: "x", width: 10, height: 10 }] }));
	assert.match(JSON.parse((await rawRequest(port, `${base}api/designs/gamma`)).body).reason, /file/);
	writeFileSync(join(root, "gamma", "design.json"), JSON.stringify({ title: "G", artboards: [{ file: "01.html", width: -1, height: 10 }] }));
	assert.equal((await rawRequest(port, `${base}api/designs/gamma`)).status, 422);
	writeFileSync(join(root, "gamma", "design.json"), JSON.stringify({ title: "G", artboards: "nope" }));
	assert.equal((await rawRequest(port, `${base}api/designs/gamma`)).status, 422);
});

test("artboard HTML is served sandboxed with the inspector injected once", async (t) => {
	const { port, base } = await start(t);
	const inspector = `<script src="${base}assets/inspector.js"></script>`;
	const hero = await rawRequest(port, `${base}files/alpha/01-hero.html`);
	assert.equal(hero.status, 200);
	assert.match(String(hero.headers["content-type"]), /^text\/html/);
	assert.equal(hero.headers["x-content-type-options"], "nosniff");
	assert.equal(hero.headers["cache-control"], "no-store");
	assert.match(String(hero.headers["content-security-policy"]), /^sandbox allow-scripts;/);
	assert.match(String(hero.headers["content-security-policy"]), /connect-src 'none'/);
	assert.equal(hero.body, `<!doctype html><html><body><h1>Hero</h1>${inspector}</body></html>`);
	assert.equal((await rawRequest(port, `${base}files/alpha/02-bare.html`)).body, `<h1>Bare</h1>${inspector}`);
	assert.equal((await rawRequest(port, `${base}files/alpha/sub/inner.html`)).status, 200);
	assert.equal((await rawRequest(port, `${base}files/alpha/alias.html`)).status, 200, "a symlink that stays inside the design is allowed");
	const css = await rawRequest(port, `${base}files/alpha/styles.css`);
	assert.equal(css.body, "h1{color:red}");
	assert.match(String(css.headers["content-type"]), /^text\/css/);
	assert.equal((await rawRequest(port, `${base}files/alpha/logo.svg`)).headers["content-type"], "image/svg+xml");
	assert.match(String((await rawRequest(port, `${base}files/alpha/design.json`)).headers["content-type"]), /^application\/json/);
});

test("traversal, symlink escape, directories and disallowed extensions are 404", async (t) => {
	const { port, base } = await start(t);
	const refused = [
		"files/alpha/../beta/01-a.html",
		"files/alpha/%2e%2e/beta/01-a.html",
		"files/alpha/%2E%2E%2Fbeta%2F01-a.html",
		"files/alpha/sub%2Finner.html",
		"files/alpha/..%5Cbeta%5C01-a.html",
		"files/../../etc/passwd",
		"files/alpha/escape.html",
		"files/alpha/linkdir/secret.html",
		"files/alpha/notes.txt",
		"files/alpha/sub",
		"files/alpha/",
		"files/alpha",
		"files/Alpha/01-hero.html",
		"files/missing/01.html",
		"files/alpha/missing.html",
		"files/alpha/.hidden.html",
		"files/alpha/01-hero.html%00.txt",
	];
	for (const path of refused) assert.equal((await rawRequest(port, `${base}${path}`)).status, 404, path);
	assert.equal((await rawRequest(port, `${base}files/alpha/%E0%A4%A`)).status, 400);
});

function postComment(port: number, body: unknown, headers: Record<string, string> = {}) {
	return rawRequest(port, `/${TOKEN}/api/comments`, {
		method: "POST",
		headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

const VALID = { slug: "alpha", file: "01-hero.html", selector: "body > h1", excerpt: "Hero", comment: "Make it bigger" };

test("comment POSTs need the exact own Origin and a JSON content type", async (t) => {
	const { port, comments } = await start(t);
	const noOrigin = await rawRequest(port, `/${TOKEN}/api/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(VALID) });
	assert.equal(noOrigin.status, 403);
	assert.equal((await postComment(port, VALID, { Origin: "http://evil.example" })).status, 403);
	assert.equal((await postComment(port, VALID, { Origin: "null" })).status, 403);
	assert.equal((await postComment(port, VALID, { Origin: `http://localhost:${port}` })).status, 403);
	assert.equal((await postComment(port, VALID, { "Content-Type": "text/plain" })).status, 415);
	assert.equal((await postComment(port, VALID, { "Content-Type": "application/x-www-form-urlencoded" })).status, 415);
	assert.equal((await rawRequest(port, `/${TOKEN}/api/comments`)).status, 405);
	assert.deepEqual(comments, []);
});

test("comment bodies and fields are bounded and validated", async (t) => {
	const { port, comments } = await start(t);
	assert.equal((await postComment(port, { ...VALID, comment: "x".repeat(17 * 1024) })).status, 413);
	assert.equal((await postComment(port, "{ nope")).status, 400);
	assert.equal((await postComment(port, "[]")).status, 400);
	const invalid = [
		{ ...VALID, comment: "   " },
		{ ...VALID, comment: "x".repeat(2001) },
		{ ...VALID, comment: 7 },
		{ ...VALID, selector: "" },
		{ ...VALID, selector: "a".repeat(501) },
		{ ...VALID, slug: "Alpha" },
		{ ...VALID, slug: "missing" },
		{ ...VALID, file: "../beta/01-a.html" },
		{ ...VALID, file: "missing.html" },
		{ ...VALID, file: "styles.css" },
		{ ...VALID, file: "escape.html" },
		{ ...VALID, excerpt: 5 },
	];
	for (const body of invalid) assert.equal((await postComment(port, body)).status, 400, JSON.stringify(body).slice(0, 80));
	assert.deepEqual(comments, []);
});

test("a valid comment is accepted with 202 and delivered trimmed and bounded", async (t) => {
	const { port, comments } = await start(t);
	const reply = await postComment(port, {
		slug: "alpha",
		file: "sub/inner.html",
		selector: "  body > main:nth-of-type(2)\n  > h1  ",
		excerpt: `  Hello\n\n   world ${"y".repeat(400)}`,
		comment: "  Use the brand color\r\nand a larger title  ",
	}, { "Content-Type": "application/json; charset=utf-8" });
	assert.equal(reply.status, 202);
	assert.equal(comments.length, 1);
	assert.deepEqual(comments[0], {
		slug: "alpha",
		file: "sub/inner.html",
		selector: "body > main:nth-of-type(2) > h1",
		excerpt: `Hello world ${"y".repeat(400)}`.slice(0, 300),
		comment: "Use the brand color\nand a larger title",
	});
	assert.equal((await postComment(port, { ...VALID, excerpt: undefined })).status, 202);
	assert.equal(comments[1].excerpt, "");
});

test("a failing onComment yields 500 without crashing the server", async (t) => {
	const { root } = fixture(t);
	const server = await startDesignCanvasServer({ designRoot: root, onComment: () => { throw new Error("boom"); }, randomToken: () => TOKEN });
	t.after(() => server.close());
	assert.equal((await postComment(server.port, VALID)).status, 500);
	assert.equal((await rawRequest(server.port, `/${TOKEN}/api/designs`)).status, 200);
});

function openEvents(port: number) {
	let buffer = "";
	const waiters: Array<{ pattern: RegExp; resolve: (match: RegExpExecArray) => void }> = [];
	const req = httpRequest({ host: "127.0.0.1", port, path: `/${TOKEN}/events`, headers: { Host: `127.0.0.1:${port}` }, setHost: false });
	const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
		req.on("response", (res) => {
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				buffer += chunk;
				for (const waiter of [...waiters]) {
					const match = waiter.pattern.exec(buffer);
					if (match) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(match); }
				}
			});
			res.on("error", () => {});
			resolve(res.headers);
		});
		req.on("error", reject);
	});
	req.end();
	const waitFor = (pattern: RegExp) => new Promise<RegExpExecArray>((resolve) => {
		const match = pattern.exec(buffer);
		if (match) resolve(match); else waiters.push({ pattern, resolve });
	});
	return { ready, waitFor, req };
}

test("events stream a debounced change after an artboard write", async (t) => {
	const { port, root } = await start(t);
	const events = openEvents(port);
	t.after(() => events.req.destroy());
	const headers = await events.ready;
	assert.match(String(headers["content-type"]), /^text\/event-stream/);
	assert.equal(headers["cache-control"], "no-store");
	await events.waitFor(/: connected\n\n/);
	await new Promise((resolve) => setTimeout(resolve, 100));
	writeFileSync(join(root, "alpha", "01-hero.html"), "<p>changed</p>");
	const match = await events.waitFor(/event: change\ndata: (\{"slug":"alpha","file":"01-hero\.html"\})\n\n/);
	assert.deepEqual(JSON.parse(match[1]), { slug: "alpha", file: "01-hero.html" });
});

test("close() is idempotent, ends event streams and frees the port", async (t) => {
	const { root } = fixture(t);
	const server = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, randomToken: () => TOKEN });
	const events = openEvents(server.port);
	await events.ready;
	await events.waitFor(/: connected\n\n/);
	await Promise.all([server.close(), server.close()]);
	await server.close();
	await assert.rejects(rawRequest(server.port, `/${TOKEN}/`), /ECONNREFUSED/);
});

test("a missing design root lists nothing and still serves the canvas", async (t) => {
	const parent = scratch(t, "gentle-design-empty-");
	const server = await startDesignCanvasServer({ designRoot: join(parent, "design"), onComment: () => {}, randomToken: () => TOKEN });
	t.after(() => server.close());
	assert.deepEqual(JSON.parse((await rawRequest(server.port, `/${TOKEN}/api/designs`)).body), { designs: [] });
	assert.equal((await rawRequest(server.port, `/${TOKEN}/`)).status, 200);
	assert.equal((await rawRequest(server.port, `/${TOKEN}/files/alpha/01.html`)).status, 404);
});

test("formatDesignComment builds the exact session message", () => {
	assert.equal(formatDesignComment({ slug: "landing", file: "02-bold.html", selector: "body > header > h1", excerpt: "Ship faster", comment: "Make the headline shorter." }), [
		"Design comment for design/landing/02-bold.html",
		"",
		"Design: landing",
		"Artboard: design/landing/02-bold.html",
		"Element: body > header > h1",
		"Excerpt: \"Ship faster\"",
		"",
		"Comment:",
		"Make the headline shorter.",
		"",
		"Edit only the artboard design/landing/02-bold.html, following the gentle-design skill.",
	].join("\n"));
	assert.match(formatDesignComment({ ...VALID, excerpt: "" }), /\nExcerpt: \(none\)\n/);
});

test("canvas assets sandbox artboards without allow-same-origin and reference no remote URL", () => {
	const canvas = readFileSync(join(ASSET_DIR, "canvas.js"), "utf8");
	assert.match(canvas, /setAttribute\("sandbox", "allow-scripts"\)/);
	for (const name of ["index.html", "canvas.css", "canvas.js", "inspector.js"]) {
		const source = readFileSync(join(ASSET_DIR, name), "utf8");
		assert.ok(!source.includes("allow-same-origin"), `${name} must not grant allow-same-origin`);
		assert.ok(!/https?:\/\//i.test(source), `${name} must not reference remote URLs`);
	}
	const inspector = readFileSync(join(ASSET_DIR, "inspector.js"), "utf8");
	assert.match(inspector, /gd:pick/);
	assert.match(canvas, /event\.source/);
});
