import { randomBytes, timingSafeEqual } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Loopback canvas host for gentle-design (S4-S6). Every route lives under a
// per-server random token, the Host header must name this server, POSTs need
// this server's own Origin, and files resolve by realpath inside designRoot.

const HOST = "127.0.0.1";
/** Design directory names the canvas serves: kebab-case, never a dot or path segment. */
export const DESIGN_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SLUG = DESIGN_SLUG;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
const ASSET_DIR = fileURLToPath(new URL("../assets/design-canvas/", import.meta.url));
const ASSETS: Readonly<Record<string, string>> = Object.freeze({
	"canvas.js": "text/javascript; charset=utf-8",
	"canvas.css": "text/css; charset=utf-8",
	"inspector.js": "text/javascript; charset=utf-8",
});
const FILE_TYPES: Readonly<Record<string, string>> = Object.freeze({
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	// No font types: artboards use system font stacks (S1), and a sandboxed
	// artboard's opaque-origin font request would be refused anyway.
});
const LIMITS = Object.freeze({
	bodyBytes: 16 * 1024,
	comment: 2000,
	selector: 500,
	excerpt: 300,
	manifestBytes: 256 * 1024,
	fileBytes: 32 * 1024 * 1024,
	artboards: 64,
	artboardSide: 20000,
	sseClients: 16,
});
const DEBOUNCE_MS = 150;
const HEARTBEAT_MS = 15_000;
const BASE_HEADERS = Object.freeze({
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
});
// Canvas and API only: artboards run in an opaque origin, so their own
// subresources (files, inspector.js) would be blocked by a same-origin CORP.
const SAME_ORIGIN_ONLY = Object.freeze({ "Cross-Origin-Resource-Policy": "same-origin" });
const CANVAS_CSP = [
	"default-src 'none'",
	"script-src 'self'",
	"style-src 'self'",
	"img-src 'self' data:",
	"connect-src 'self'",
	"frame-src 'self'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join("; ");

export type DesignComment = { slug: string; file: string; selector: string; excerpt: string; comment: string };

export type DesignCanvasServerOptions = {
	/** Absolute `<session cwd>/design` directory. */
	designRoot: string;
	onComment: (comment: DesignComment) => void | Promise<void>;
	initialSlug?: string;
	randomToken?: () => string;
};

export type DesignCanvasServer = { url: string; port: number; token: string; close(): Promise<void> };

export type DesignArtboard = { file: string; title: string; tradeoff: string; width: number; height: number };
export type DesignManifest = { slug: string; title: string; brief: string; artboards: DesignArtboard[] };

class HttpError extends Error {
	readonly status: number;
	readonly reason: string;
	constructor(status: number, reason: string) {
		super(reason);
		this.status = status;
		this.reason = reason;
	}
}

/** Session message for one canvas comment; paths are relative to the session cwd. */
export function formatDesignComment(comment: DesignComment): string {
	const artboard = `design/${comment.slug}/${comment.file}`;
	return [
		`Design comment for ${artboard}`,
		"",
		`Design: ${comment.slug}`,
		`Artboard: ${artboard}`,
		`Element: ${comment.selector}`,
		`Excerpt: ${comment.excerpt ? JSON.stringify(comment.excerpt) : "(none)"}`,
		"",
		"Comment:",
		comment.comment,
		"",
		`Edit only the artboard ${artboard}, following the gentle-design skill.`,
	].join("\n");
}

function sameToken(expected: string, candidate: string): boolean {
	const a = Buffer.from(expected);
	const b = Buffer.from(candidate);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** One decoded path segment, or null when it could name anything but a plain entry. */
function safeSegment(raw: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		throw new HttpError(400, "malformed-url");
	}
	if (decoded === "" || decoded.startsWith(".") || /[\/\\\0:]/.test(decoded) || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
	return decoded;
}

/** Relative path such as `sub/01-a.html` split into plain segments, or null. */
function relativeSegments(value: unknown): string[] | null {
	if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
	const parts = value.split("/");
	for (const part of parts) {
		if (part === "" || part.startsWith(".") || /[\\\0:]/.test(part) || /[\u0000-\u001f\u007f]/.test(part)) return null;
	}
	return parts;
}

function within(root: string, target: string): boolean {
	return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException)?.code;
	return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "EACCES" || code === "EPERM";
}

function collapse(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function normalizeManifest(slug: string, raw: string): DesignManifest {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new HttpError(422, "design.json is not valid JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(422, "design.json must be a JSON object");
	const record = value as Record<string, unknown>;
	if (record.title !== undefined && typeof record.title !== "string") throw new HttpError(422, "title must be a string");
	if (record.brief !== undefined && typeof record.brief !== "string") throw new HttpError(422, "brief must be a string");
	if (!Array.isArray(record.artboards)) throw new HttpError(422, "artboards must be an array");
	if (record.artboards.length > LIMITS.artboards) throw new HttpError(422, `artboards must have at most ${LIMITS.artboards} entries`);
	const artboards = record.artboards.map((entry: unknown, index: number): DesignArtboard => {
		const where = `artboards[${index}]`;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new HttpError(422, `${where} must be an object`);
		const board = entry as Record<string, unknown>;
		const segments = relativeSegments(board.file);
		if (!segments || extname(segments[segments.length - 1]).toLowerCase() !== ".html") throw new HttpError(422, `${where}.file must be a relative .html path inside the design`);
		for (const key of ["title", "tradeoff"] as const) {
			if (board[key] !== undefined && typeof board[key] !== "string") throw new HttpError(422, `${where}.${key} must be a string`);
		}
		for (const key of ["width", "height"] as const) {
			const size = board[key];
			if (!Number.isInteger(size) || (size as number) < 1 || (size as number) > LIMITS.artboardSide) throw new HttpError(422, `${where}.${key} must be an integer between 1 and ${LIMITS.artboardSide}`);
		}
		return {
			file: segments.join("/"),
			title: typeof board.title === "string" && board.title.trim() ? board.title.trim() : segments.join("/"),
			tradeoff: typeof board.tradeoff === "string" ? board.tradeoff.trim() : "",
			width: board.width as number,
			height: board.height as number,
		};
	});
	const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : slug;
	return { slug, title, brief: typeof record.brief === "string" ? record.brief.trim() : "", artboards };
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** JSON safe to place inside a `<script type="application/json">` element. */
function scriptJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function injectInspector(html: string, tag: string): string {
	const index = html.toLowerCase().lastIndexOf("</body>");
	return index === -1 ? html + tag : html.slice(0, index) + tag + html.slice(index);
}

function mediaType(req: IncomingMessage): string {
	return String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
}

async function readBody(req: IncomingMessage): Promise<string> {
	const declared = Number(req.headers["content-length"]);
	if (Number.isFinite(declared) && declared > LIMITS.bodyBytes) throw new HttpError(413, "body-too-large");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > LIMITS.bodyBytes) throw new HttpError(413, "body-too-large");
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export async function startDesignCanvasServer(options: DesignCanvasServerOptions): Promise<DesignCanvasServer> {
	if (typeof options.designRoot !== "string" || !isAbsolute(options.designRoot)) throw new Error("designRoot must be an absolute path");
	if (typeof options.onComment !== "function") throw new Error("onComment must be a function");
	if (options.initialSlug !== undefined && !SLUG.test(options.initialSlug)) throw new Error("initialSlug must be kebab-case");
	const token = (options.randomToken ?? (() => randomBytes(24).toString("base64url")))();
	if (!TOKEN_SHAPE.test(token)) throw new Error("token must be 16-128 base64url characters");
	const designRoot = options.designRoot;
	const base = `/${token}/`;
	const template = await readFile(join(ASSET_DIR, "index.html"), "utf8");

	let port = 0;
	let origin = "";
	let closing: Promise<void> | undefined;
	let watcher: FSWatcher | undefined;
	const clients = new Set<ServerResponse>();
	const pending = new Map<string, NodeJS.Timeout>();
	let heartbeat: NodeJS.Timeout | undefined;

	const server = createServer({ maxHeaderSize: 16 * 1024, requireHostHeader: false }, (req, res) => {
		handle(req, res).catch((error: unknown) => {
			if (res.headersSent) return void res.destroy();
			if (error instanceof HttpError) {
				const body = error.status === 422 ? { error: "invalid-manifest", reason: error.reason } : { error: error.reason };
				return reply(res, error.status, body, error.status === 413 ? { Connection: "close" } : {});
			}
			reply(res, 500, { error: "internal" });
		});
	});
	server.headersTimeout = 10_000;
	server.requestTimeout = 30_000;
	server.keepAliveTimeout = 5_000;

	function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
		const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
		res.writeHead(status, {
			...BASE_HEADERS,
			...SAME_ORIGIN_ONLY,
			"Content-Type": "application/json; charset=utf-8",
			...headers,
			"Content-Length": String(Buffer.byteLength(payload)),
		});
		res.end(payload);
	}

	/** 200 for content the opaque-origin artboards load, so it carries no same-origin CORP. */
	function raw(res: ServerResponse, body: string | Buffer, headers: Record<string, string>): void {
		res.writeHead(200, { ...BASE_HEADERS, ...headers, "Content-Length": String(Buffer.byteLength(body)) });
		res.end(body);
	}

	async function rootReal(): Promise<string | undefined> {
		try {
			return await realpath(designRoot);
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
	}

	/** Real path of `<root>/<slug>/<segments>` when it stays inside that design, else undefined. */
	async function resolveInside(slug: string, segments: string[]): Promise<string | undefined> {
		const root = await rootReal();
		if (!root || !SLUG.test(slug)) return undefined;
		try {
			const design = await realpath(join(root, slug));
			if (!within(root, design) || design === root) return undefined;
			const target = await realpath(join(design, ...segments));
			return within(design, target) && target !== design ? target : undefined;
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
	}

	async function readManifest(slug: string): Promise<DesignManifest> {
		const path = await resolveInside(slug, ["design.json"]);
		if (!path) throw new HttpError(404, "not-found");
		const info = await stat(path);
		if (!info.isFile()) throw new HttpError(404, "not-found");
		if (info.size > LIMITS.manifestBytes) throw new HttpError(422, "design.json is too large");
		return normalizeManifest(slug, await readFile(path, "utf8"));
	}

	async function listDesigns() {
		const root = await rootReal();
		if (!root) return [];
		const entries = await readdir(root, { withFileTypes: true });
		const designs: Array<{ slug: string; title: string; mtime: number; valid: boolean }> = [];
		for (const entry of entries) {
			if (!SLUG.test(entry.name) || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
			const path = await resolveInside(entry.name, ["design.json"]);
			if (!path) continue;
			const info = await stat(path).catch(() => undefined);
			if (!info?.isFile()) continue;
			let title = entry.name;
			let valid = false;
			try {
				if (info.size <= LIMITS.manifestBytes) {
					title = normalizeManifest(entry.name, await readFile(path, "utf8")).title;
					valid = true;
				}
			} catch {
				valid = false;
			}
			designs.push({ slug: entry.name, title, mtime: info.mtimeMs, valid });
		}
		return designs.sort((a, b) => b.mtime - a.mtime || a.slug.localeCompare(b.slug));
	}

	function canvasPage(res: ServerResponse, slug: string | null): void {
		const html = template
			.replaceAll("{{BASE}}", escapeHtml(base))
			.replace("{{CONFIG}}", () => scriptJson({ base, slug }));
		reply(res, 200, html, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CANVAS_CSP });
	}

	async function serveAsset(res: ServerResponse, name: string | null): Promise<void> {
		if (!name || !Object.hasOwn(ASSETS, name)) throw new HttpError(404, "not-found");
		raw(res, await readFile(join(ASSET_DIR, name)), { "Content-Type": ASSETS[name] });
	}

	/** Artboard responses are CSP-sandboxed so even a top-level visit gets an opaque origin. */
	function artboardCsp(host: string): string {
		const self = `'self' http://${host}`;
		return [
			"sandbox allow-scripts",
			`default-src ${self} 'unsafe-inline' data: blob:`,
			"connect-src 'none'",
			"base-uri 'none'",
			"form-action 'none'",
			`frame-ancestors http://${HOST}:${port} http://localhost:${port}`,
		].join("; ");
	}

	async function serveFile(req: IncomingMessage, res: ServerResponse, slug: string, segments: string[]): Promise<void> {
		const type = FILE_TYPES[extname(segments[segments.length - 1]).toLowerCase()];
		if (!type) throw new HttpError(404, "not-found");
		const target = await resolveInside(slug, segments);
		if (!target || FILE_TYPES[extname(target).toLowerCase()] !== type) throw new HttpError(404, "not-found");
		// Read the already-resolved real path so a swapped link cannot redirect the read.
		const handle = await open(target, "r").catch((error: unknown) => { if (isMissing(error)) throw new HttpError(404, "not-found"); throw error; });
		let content: Buffer;
		try {
			const info = await handle.stat();
			if (!info.isFile()) throw new HttpError(404, "not-found");
			if (info.size > LIMITS.fileBytes) throw new HttpError(413, "file-too-large");
			content = await handle.readFile();
		} finally {
			await handle.close();
		}
		const body = type.startsWith("text/html")
			? injectInspector(content.toString("utf8"), `<script src="${escapeHtml(base)}assets/inspector.js"></script>`)
			: content;
		raw(res, body, { "Content-Type": type, "Content-Security-Policy": artboardCsp(String(req.headers.host)) });
	}

	async function receiveComment(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.headers.origin !== origin) throw new HttpError(403, "forbidden");
		if (mediaType(req) !== "application/json") throw new HttpError(415, "unsupported-media-type");
		const raw = await readBody(req);
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			throw new HttpError(400, "invalid-json");
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid-body");
		const body = value as Record<string, unknown>;
		if (typeof body.slug !== "string" || !SLUG.test(body.slug)) throw new HttpError(400, "invalid-slug");
		const segments = relativeSegments(body.file);
		if (!segments || extname(segments[segments.length - 1]).toLowerCase() !== ".html") throw new HttpError(400, "invalid-file");
		if (typeof body.comment !== "string") throw new HttpError(400, "invalid-comment");
		const comment = body.comment.replace(/\r\n?/g, "\n").trim();
		if (comment.length < 1 || comment.length > LIMITS.comment) throw new HttpError(400, "invalid-comment");
		if (typeof body.selector !== "string") throw new HttpError(400, "invalid-selector");
		const selector = collapse(body.selector);
		if (selector.length < 1 || selector.length > LIMITS.selector) throw new HttpError(400, "invalid-selector");
		if (body.excerpt !== undefined && typeof body.excerpt !== "string") throw new HttpError(400, "invalid-excerpt");
		const excerpt = Array.from(collapse(typeof body.excerpt === "string" ? body.excerpt : "")).slice(0, LIMITS.excerpt).join("").trim();
		const target = await resolveInside(body.slug, segments);
		const info = target ? await stat(target).catch(() => undefined) : undefined;
		if (!target || !info?.isFile() || extname(target).toLowerCase() !== ".html") throw new HttpError(400, "invalid-file");
		try {
			await options.onComment({ slug: body.slug, file: segments.join("/"), selector, excerpt, comment });
		} catch {
			throw new HttpError(500, "delivery-failed");
		}
		reply(res, 202, { ok: true });
	}

	function broadcast(chunk: string): void {
		for (const client of clients) client.write(chunk);
	}

	function queueChange(filename: string): void {
		if (closing) return;
		const parts = filename.split(/[\\/]/);
		const [slug, ...rest] = parts;
		if (!SLUG.test(slug) || rest.length === 0 || rest.some((part) => part === "" || part.startsWith("."))) return;
		if (!FILE_TYPES[extname(rest[rest.length - 1]).toLowerCase()]) return;
		const file = rest.join("/");
		const key = `${slug}/${file}`;
		clearTimeout(pending.get(key));
		pending.set(key, setTimeout(() => {
			pending.delete(key);
			broadcast(`event: change\ndata: ${JSON.stringify({ slug, file })}\n\n`);
		}, DEBOUNCE_MS));
	}

	/** Recursive watch on the real design root; a failed or missing watch is retried by the next stream. */
	async function ensureWatcher(): Promise<void> {
		if (watcher || closing) return;
		const root = await rootReal();
		if (!root || watcher || closing) return;
		try {
			const next = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
				if (typeof filename === "string" && filename) queueChange(filename);
			});
			next.on("error", () => {
				next.close();
				if (watcher === next) watcher = undefined;
			});
			watcher = next;
		} catch {
			watcher = undefined;
		}
	}

	async function openEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (clients.size >= LIMITS.sseClients) throw new HttpError(503, "too-many-streams");
		await ensureWatcher();
		res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive" });
		res.write("retry: 2000\n\n: connected\n\n");
		clients.add(res);
		req.socket.setTimeout(0);
		const drop = () => clients.delete(res);
		req.on("close", drop);
		res.on("error", drop);
		heartbeat ??= setInterval(() => broadcast(": ping\n\n"), HEARTBEAT_MS);
		heartbeat.unref();
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const host = req.headers.host;
		if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) return reply(res, 421, { error: "misdirected" });
		const raw = String(req.url ?? "");
		if (!raw.startsWith("/")) return reply(res, 404, { error: "not-found" });
		const mark = raw.indexOf("?");
		const parts = (mark === -1 ? raw : raw.slice(0, mark)).split("/");
		// parts[0] is the empty string before the leading slash.
		if (parts.length < 3 || !sameToken(token, parts[1])) return reply(res, 404, { error: "not-found" });
		const rest = parts.slice(2);
		const method = req.method ?? "GET";
		const isComment = rest.length === 2 && rest[0] === "api" && rest[1] === "comments";
		if (method !== (isComment ? "POST" : "GET")) {
			// Unknown paths stay 404 whatever the method; only known routes answer 405.
			if (isComment || route(rest) !== undefined) return reply(res, 405, { error: "method-not-allowed" }, { Allow: isComment ? "POST" : "GET" });
			return reply(res, 404, { error: "not-found" });
		}
		if (isComment) return receiveComment(req, res);
		// Browsers send Origin on cross-origin reads; only this server's pages may read it.
		// Sandboxed artboards fetch their own subresources with `Origin: null`.
		const requestOrigin = req.headers.origin;
		const artboardSubresource = rest[0] === "files" || (rest.length === 2 && rest[0] === "assets" && rest[1] === "inspector.js");
		const trusted = requestOrigin === undefined || requestOrigin === origin || requestOrigin === `http://localhost:${port}` || (requestOrigin === "null" && artboardSubresource);
		if (!trusted) return reply(res, 403, { error: "forbidden" });
		const found = route(rest);
		if (!found) return reply(res, 404, { error: "not-found" });
		return found(req, res);
	}

	type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

	/** GET route table over raw (still encoded) segments after the token. */
	function route(rest: string[]): Handler | undefined {
		const [head, ...tail] = rest;
		if (rest.length === 1 && head === "") return (_req, res) => canvasPage(res, null);
		if (head === "d" && tail.length === 2 && tail[1] === "") {
			const slug = safeSegment(tail[0]);
			return slug && SLUG.test(slug) ? (_req, res) => canvasPage(res, slug) : undefined;
		}
		if (head === "assets" && tail.length === 1) return (_req, res) => serveAsset(res, safeSegment(tail[0]));
		if (head === "events" && tail.length === 0) return openEvents;
		if (head === "api" && tail[0] === "designs") {
			if (tail.length === 1) return async (_req, res) => reply(res, 200, { designs: await listDesigns() });
			if (tail.length === 2) {
				const slug = safeSegment(tail[1]);
				return slug && SLUG.test(slug) ? async (_req, res) => reply(res, 200, await readManifest(slug)) : undefined;
			}
		}
		if (head === "files" && tail.length >= 2) {
			const slug = safeSegment(tail[0]);
			if (!slug || !SLUG.test(slug)) return undefined;
			const segments = tail.slice(1).map(safeSegment);
			if (segments.some((segment) => segment === null)) return undefined;
			return (req, res) => serveFile(req, res, slug, segments as string[]);
		}
		return undefined;
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, HOST, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string" || address.address !== HOST) {
		server.close();
		throw new Error("design canvas server is not bound to 127.0.0.1");
	}
	port = address.port;
	origin = `http://${HOST}:${port}`;
	await ensureWatcher();

	function close(): Promise<void> {
		closing ??= new Promise<void>((resolve) => {
			clearInterval(heartbeat);
			for (const timer of pending.values()) clearTimeout(timer);
			pending.clear();
			watcher?.close();
			watcher = undefined;
			for (const client of clients) client.destroy();
			clients.clear();
			server.close(() => resolve());
			server.closeAllConnections();
		});
		return closing;
	}

	const url = `${origin}${base}${options.initialSlug ? `d/${options.initialSlug}/` : ""}`;
	return { url, port, token, close };
}
