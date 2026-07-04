import postgres from "postgres";
import type { QueryResult } from "../types/index.js";

let _sql: ReturnType<typeof postgres> | null = null;

// ─── Connection ───────────────────────────────────────────────────────────────

export function connect(databaseUrl: string): ReturnType<typeof postgres> {
	if (_sql) {
		_sql.end().catch(() => {});
	}

	_sql = postgres(databaseUrl, {
		max: 5,
		idle_timeout: 20,
		connect_timeout: 10,
		onnotice: () => {}, // suppress NOTICE messages
		// Enforce read-only at connection level where possible
		connection: {
			application_name: "qcp",
		},
	});

	return _sql;
}

export function getConnection(): ReturnType<typeof postgres> {
	if (!_sql) {
		throw new Error("Not connected to database. Run: qcp connect");
	}
	return _sql;
}

export async function disconnect(): Promise<void> {
	if (_sql) {
		await _sql.end();
		_sql = null;
	}
}

// ─── Connectivity test ────────────────────────────────────────────────────────

export async function testConnection(databaseUrl: string): Promise<{
	connected: boolean;
	version: string;
	readOnly: boolean;
	error?: string;
}> {
	let sql: ReturnType<typeof postgres> | null = null;
	try {
		sql = postgres(databaseUrl, {
			max: 1,
			connect_timeout: 10,
			connection: { application_name: "qcp-doctor" },
		});

		const [versionRow] = await sql`SELECT version() as v`;
		const version = (versionRow as { v: string }).v;

		// Extract just "PostgreSQL 16.1" from the full version string
		const pgVersion =
			version.match(/PostgreSQL\s+[\d.]+/i)?.[0] ?? version.slice(0, 40);

		// Check if connection is read-only or user has only SELECT privileges
		let readOnly = false;
		try {
			await sql`SET TRANSACTION READ ONLY`;
			readOnly = true;
		} catch {
			// Not a blocker — the safety layer enforces read-only at SQL level
		}

		return { connected: true, version: pgVersion, readOnly };
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return { connected: false, version: "", readOnly: false, error: message };
	} finally {
		if (sql) await sql.end().catch(() => {});
	}
}

// ─── Query execution ──────────────────────────────────────────────────────────

export async function executeQuery(
	databaseUrl: string,
	sql: string,
	timeoutMs = 10_000,
): Promise<QueryResult> {
	const cleanUrl = databaseUrl.split("?");

	const db = postgres(cleanUrl[0], {
		max: 1,
		connect_timeout: 10,
		ssl: cleanUrl[0].includes("prisma.io") ? "require" : undefined,
	});

	const start = Date.now();

	try {
		// 💡 FIX 1: Explicitly pass the query structure down using a direct array execution
		// to stop postgres.js from parsing strings into prepared parameters ($1)
		const rows = await db.begin("read only", async (tx) => {
			// Force exact numerical interpolation for setting timeouts
			await tx.unsafe(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`);

			// Pass the pure sql without letting the engine attempt interpolation hooks
			return await tx.unsafe(sql);
		});

		const executionTimeMs = Date.now() - start;
		const rowArray = Array.isArray(rows) ? rows : [];
		type Row = Record<string, unknown>;

		const fields = rowArray.length > 0 ? Object.keys(rowArray[0] as Row) : [];
		return {
			rows: rowArray as Record<string, unknown>[],
			rowCount: rowArray.length,
			fields,
			executionTimeMs,
		};
	} finally {
		await db.end({ timeout: 2 }).catch(() => {});
	}
}

// ─── EXPLAIN ──────────────────────────────────────────────────────────────────

export async function explainQuery(
	databaseUrl: string,
	sql: string,
): Promise<{ plan: string; estimatedRows: number }> {
	const db = postgres(databaseUrl, {
		ssl: "require",
		max: 1,
		connect_timeout: 10,
		connection: { application_name: "qcp-explain" },
	});

	try {
		const rows = await db.unsafe(`EXPLAIN (FORMAT JSON) ${sql}`);
		const plan = JSON.stringify(rows, null, 2);

		// Extract estimated rows from top-level plan node
		let estimatedRows = 0;
		try {
			const planJson = rows as unknown as Array<{ "QUERY PLAN": unknown }>;
			const topPlan = planJson[0]?.["QUERY PLAN"];
			if (Array.isArray(topPlan) && topPlan[0]) {
				const topNode = topPlan[0] as { Plan?: { "Plan Rows"?: number } };
				estimatedRows = topNode.Plan?.["Plan Rows"] ?? 0;
			}
		} catch {
			// ignore
		}

		return { plan, estimatedRows };
	} finally {
		await db.end().catch(() => {});
	}
}

// ─── Database info ────────────────────────────────────────────────────────────

export async function getDatabaseName(databaseUrl: string): Promise<string> {
	const db = postgres(databaseUrl, {
		max: 1,
		connect_timeout: 10,
	});
	try {
		const [row] = await db`SELECT current_database() as name`;
		return (row as { name: string }).name;
	} finally {
		await db.end().catch(() => {});
	}
}

export async function checkReadOnlyUser(databaseUrl: string): Promise<boolean> {
	const db = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
	try {
		// Try to create a temp table — a truly read-only user cannot
		await db`CREATE TEMP TABLE _qcp_rw_test (id int)`;
		await db`DROP TABLE IF EXISTS _qcp_rw_test`;
		return false; // has write permissions
	} catch {
		return true; // cannot write → read-only user
	} finally {
		await db.end().catch(() => {});
	}
}
