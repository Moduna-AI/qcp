import chalk from "chalk";
import ora from "ora";
import {
	getDatabaseUrl,
	LOCAL_SCHEMA_PATH,
	loadConfig,
} from "@/config/index.js";
import { log } from "@/logger/index.js";
import {
	printError,
	printInfo,
	printSection,
	printSuccess,
} from "@/output/index.js";
import { loadSchema, saveSchema, scanSchema } from "@/schema/index.js";
import { trackSchemaScan } from "@/telemetry/index.js";

export async function schemaScanCommand(): Promise<void> {
	const config = loadConfig();
	const databaseUrl = getDatabaseUrl(config);

	if (!databaseUrl) {
		printError("No database connection configured.", "Run: qcp connect");
		process.exit(1);
	}

	const spinner = ora("Scanning database schema...").start();

	try {
		const schema = await scanSchema(databaseUrl);
		spinner.succeed(
			`Scanned ${schema.tableCount} tables from ${schema.databaseName}`,
		);

		saveSchema(schema);

		trackSchemaScan(schema.tableCount);

		printSuccess(`Schema saved to ${LOCAL_SCHEMA_PATH}`);
		console.log();

		// Show a preview of discovered tables
		const maxPreview = 20;
		const preview = schema.tables.slice(0, maxPreview);

		printSection("Tables discovered");
		for (const table of preview) {
			const tableId =
				table.schema === "public"
					? table.name
					: `${table.schema}.${table.name}`;
			const cols = `${table.columns.length} columns`;
			const rows =
				table.estimatedRows !== undefined && table.estimatedRows > 0
					? chalk.dim(` ~${table.estimatedRows.toLocaleString()} rows`)
					: "";
			console.log(`  ${chalk.cyan(tableId)} ${chalk.dim(`(${cols})`)}${rows}`);
		}

		if (schema.tableCount > maxPreview) {
			console.log(
				chalk.dim(`  ... and ${schema.tableCount - maxPreview} more`),
			);
		}

		console.log();
		printInfo(`You can now run: qcp ask "Your question here"`);

		log("info", "Schema scanned", {
			tables: schema.tableCount,
			db: schema.databaseName,
		});
	} catch (err: unknown) {
		spinner.fail("Schema scan failed");
		const message = err instanceof Error ? err.message : String(err);
		printError(message);
		log("error", "Schema scan failed", { error: message });
		process.exit(1);
	}
}

export function schemaInfoCommand(): void {
	try {
		const schema = loadSchema();
		const scannedAt = new Date(schema.scannedAt).toLocaleString();

		printSection("Schema Info");
		console.log(`  Database: ${chalk.bold(schema.databaseName)}`);
		console.log(`  Tables:   ${chalk.bold(String(schema.tableCount))}`);
		console.log(`  Scanned:  ${chalk.dim(scannedAt)}`);
		console.log();

		printSection("Tables");
		for (const table of schema.tables) {
			const tableId =
				table.schema === "public"
					? table.name
					: `${table.schema}.${table.name}`;
			const fkCount = table.foreignKeys.length;
			const fkStr = fkCount > 0 ? chalk.dim(` → ${fkCount} FK`) : "";
			console.log(
				`  ${chalk.cyan(tableId)} ` +
					chalk.dim(`(${table.columns.length} cols)`) +
					fkStr,
			);
		}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		printError(message);
		process.exit(1);
	}
}
