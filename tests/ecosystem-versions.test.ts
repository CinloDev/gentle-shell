import assert from "node:assert/strict";
import test from "node:test";
import * as ecosystem from "../lib/ecosystem-versions.ts";

const { describeEcosystemVersions, detectEcosystemVersions, parseEngramHealthVersion } = ecosystem;
const flat = (rows: ReturnType<typeof describeEcosystemVersions>) => rows.map(row => [row.id, row.version, row.source]);

test("without the integration, only Pi and Shell appear even if an Engram version is supplied", () => {
	assert.deepEqual(flat(describeEcosystemVersions({ packageVersion: "4.7.0", piVersion: "1.0.0", engramRunningVersion: "3.7.0" })), [
		["pi", "1.0.0", "runtime"], ["shell", "4.7.0", "package"],
	]);
	assert.deepEqual(flat(describeEcosystemVersions({})), [["pi", undefined, "unavailable"], ["shell", undefined, "unavailable"]]);
});

test("enabled Engram shows its live version or honest unavailability, never an installer pin", () => {
	for (const version of ["3.7.0", undefined, "", " ", "x".repeat(41)]) {
		const detection = { engramEnabled: true, engramRunningVersion: version, engramPin: "9.9.9" };
		assert.deepEqual(flat(describeEcosystemVersions(detection)), [
			["pi", undefined, "unavailable"], ["shell", undefined, "unavailable"],
			["engram", version === "3.7.0" ? version : undefined, version === "3.7.0" ? "running" : "unavailable"],
		]);
	}
});

test("versions from local metadata remain sanitized and blank or overlong values are never shown", () => {
	const rows = describeEcosystemVersions({ packageVersion: "\u001b[31m4.7.0\n", piVersion: "", engramEnabled: true, engramRunningVersion: "  " });
	assert.deepEqual(flat(rows), [["pi", undefined, "unavailable"], ["shell", "4.7.0", "package"], ["engram", undefined, "unavailable"]]);
	assert.equal(describeEcosystemVersions({ piVersion: "1".repeat(41) })[0].version, undefined);
});

test("active Pi identity wins over adjacent metadata and Shell reads remain independent", () => {
	const reads: string[] = [];
	assert.deepEqual(detectEcosystemVersions({
		packageRoot: "/pkg", engramEnabled: true, piVersion: "99.2.3-future.1",
		readJson: path => { reads.push(path); return path === "/pkg/package.json" ? { version: "\u001b[31m4.7.0\n" } : { name: "@earendil-works/pi-coding-agent", version: "1.5.2" }; },
	}), { packageVersion: "4.7.0", piVersion: "99.2.3-future.1", engramEnabled: true });
	assert.deepEqual(reads, ["/pkg/package.json"]);
	assert.deepEqual(flat(describeEcosystemVersions({ piVersion: "99.2.3-future.1" }))[0], ["pi", "99.2.3-future.1", "runtime"]);
});

test("missing, invalid and synthetic host identity never falls back to adjacent metadata", () => {
	for (const piVersion of [undefined, "", " ", "garbage", "1.2", "0.0.0", "\u001b[31m1.5.2", "1.5.2\n", "1".repeat(41)]) {
		const reads: string[] = [];
		const detection = detectEcosystemVersions({ piVersion, readJson: path => {
			reads.push(path);
			return { name: "@earendil-works/pi-coding-agent", version: "1.5.2" };
		} });
		assert.equal(detection.piVersion, undefined, JSON.stringify(piVersion));
		assert.deepEqual(flat(describeEcosystemVersions({ piVersion }))[0], ["pi", undefined, "unavailable"]);
		assert.equal(reads.length, 1, "only Shell metadata is read");
	}
});

test("missing or unreadable metadata has no installer fallback and preserves integration presence", () => {
	for (const engramEnabled of [false, true]) {
		const detection = detectEcosystemVersions({ packageRoot: "/pkg", engramEnabled, readJson: () => undefined });
		assert.deepEqual(detection, { packageVersion: undefined, piVersion: undefined, engramEnabled });
		assert.deepEqual(flat(describeEcosystemVersions(detection)), [
			["pi", undefined, "unavailable"], ["shell", undefined, "unavailable"],
			...(engramEnabled ? [["engram", undefined, "unavailable"]] : []),
		]);
	}
});

test("integration presence requires one live mem_current_project with Gentle Engram package provenance", () => {
	const valid = { name: "mem_current_project", sourceInfo: { origin: "package", source: "npm:gentle-engram", path: "/pkg/engram/index.ts" } };
	for (const source of ["npm:gentle-engram", "npm:gentle-engram@0.4.2"]) {
		assert.equal(ecosystem.isEngramIntegrationEnabled([{ ...valid, sourceInfo: { ...valid.sourceInfo, source } }, { name: "read" }]), true, source);
	}
	const rejected = [
		[], [{ name: "mem_save" }], [{ name: "mem_current_project" }], [valid, valid],
		[{ ...valid, sourceInfo: { ...valid.sourceInfo, origin: "local" } }],
		...["npm:other", "npm:gentle-engram-extra", "npm:gentle-engram@", "npm:gentle-engram@bad/version", "npm:gentle-engram@bad version"].map(source => [{ ...valid, sourceInfo: { ...valid.sourceInfo, source } }]),
		...[undefined, "", "builtin:engram", "<unknown>"].map(path => [{ ...valid, sourceInfo: { ...valid.sourceInfo, path } }]),
	];
	for (const tools of rejected) assert.equal(ecosystem.isEngramIntegrationEnabled(tools), false, JSON.stringify(tools));
});

test("the Engram health payload reports a version only when it carries one", () => {
	for (const body of [{ version: "3.7.0" }, { version: "v3.7.0" }, { engram_version: "3.7.0" }]) assert.equal(parseEngramHealthVersion(body), "3.7.0", JSON.stringify(body));
	for (const body of [null, undefined, {}, { version: 3 }, { version: "" }, { version: "  " }, { status: "ok" }, "3.7.0"]) assert.equal(parseEngramHealthVersion(body), undefined, JSON.stringify(body));
	assert.equal(parseEngramHealthVersion({ version: "\u001b[31m3.7.0\n" }), "3.7.0");
});
