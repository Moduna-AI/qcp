#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isQcpWebAuthConfigured } from "@moduna/qcp/web";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const port = process.env.PORT ?? "3000";
console.log(`Starting qcp-web on http://127.0.0.1:${port}`);
if (!isQcpWebAuthConfigured()) {
	console.log(
		"First launch: open the browser and choose a local qcp-web passcode.",
	);
	console.log("qcp will store only a hash in ~/.qcp/config.json.");
}

const child = Bun.spawn(
	["bun", "run", "next", "dev", "-H", "127.0.0.1", "-p", port],
	{
		cwd: appDir,
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
	},
);

const exitCode = await child.exited;
process.exit(exitCode);
