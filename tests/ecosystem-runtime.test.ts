import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { describeEcosystemVersions, detectEcosystemVersions } from "../lib/ecosystem-versions.ts";

test("production STAT structurally shares MAIN stats, spend and subscription sources, including invalidation", () => {
	const source = readFileSync(new URL("../extensions/gentle-shell.ts", import.meta.url), "utf8");
	const file = ts.createSourceFile("gentle-shell.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const declarations = new Map<string, string>();
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
			declarations.set(node.name.text, node.initializer.getText(file));
		ts.forEachChild(node, visit);
	};
	visit(file);
	assert.equal(declarations.get("footerModel"), "footerStatus.model", "reuse MAIN's memoized model source");
	for (const name of ["withStats", "statsRailSnapshot"]) {
		assert.match(declarations.get(name) ?? "", /\.\.\.currentStats\(\), subagents: subagentSpend\(\)/, `${name} shares collector and spend`);
	}
	assert.match(declarations.get("currentStats") ?? "", /collectSessionStats\(ctx\.sessionManager\.getEntries\(\)\)/);
	assert.match(declarations.get("statsRailSnapshot") ?? "", /subscription: footerModel\(\)\.subscription/, "STAT must forward MAIN subscription state");
	const card = declarations.get("statsCard") ?? "";
	const digest = card.slice(card.indexOf("digest:"), card.indexOf("surface:"));
	assert.match(digest, /footerModel\(\)\.subscription/, "subscription changes must invalidate STAT rows");
});

// Probe the exact production host import without starting Shell, discovering
// resources, or reading user configuration. No substitute host modules are used.
test("production STAT forwards the real Pi public ESM VERSION export", async () => {
	const source = readFileSync(new URL("../extensions/gentle-shell.ts", import.meta.url), "utf8");
	const file = ts.createSourceFile("gentle-shell.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const hostImport = file.statements.find((node): node is ts.ImportDeclaration =>
		ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
		&& node.moduleSpecifier.text === "@earendil-works/pi-coding-agent");
	assert.ok(hostImport);
	const bindings = hostImport.importClause?.namedBindings;
	assert.ok(bindings && ts.isNamedImports(bindings));
	const versionBinding = bindings.elements.find(binding => (binding.propertyName ?? binding.name).text === "VERSION");
	assert.ok(versionBinding, "STAT must import VERSION from the host public namespace");
	const localName = versionBinding.name.text;
	const probe = hostImport.getText(file).replace('"@earendil-works/pi-coding-agent"', JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent")))
		+ `\nexport { ${localName} as hostVersion };`;
	const output = ts.transpileModule(probe, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext } }).outputText;
	const { hostVersion } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
	assert.equal(hostVersion, VERSION);
	assert.match(hostVersion, /^\d+\.\d+\.\d+/);
	assert.notEqual(hostVersion, "0.0.0");

	const calls: ts.CallExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && node.expression.getText(file) === "detectEcosystemVersions") calls.push(node);
		ts.forEachChild(node, visit);
	};
	visit(file);
	assert.equal(calls.length, 1);
	const args = calls[0].arguments[0];
	assert.ok(args && ts.isObjectLiteralExpression(args));
	const property = args.properties.find(node => node.name?.getText(file) === "piVersion");
	assert.ok(property && ts.isPropertyAssignment(property), "STAT must explicitly pass host identity");
	assert.equal(property.initializer.getText(file), localName);
	assert.deepEqual(describeEcosystemVersions(detectEcosystemVersions({ piVersion: hostVersion }))[0], {
		id: "pi", label: "Pi", version: VERSION, source: "runtime",
	});
});
