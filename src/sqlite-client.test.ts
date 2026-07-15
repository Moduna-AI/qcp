import { expect, test } from "bun:test";
import { createLocalSqliteClient } from "./sqlite-client.js";

test("local SQLite client works without lazy libSQL resolution under Bun", async () => {
	const client = await createLocalSqliteClient(":memory:");
	try {
		await client.execute("CREATE TABLE example (name TEXT NOT NULL)");
		await client.execute({
			sql: "INSERT INTO example (name) VALUES (?)",
			args: ["chinook"],
		});

		const result = await client.execute("SELECT name FROM example");
		expect(result.rows).toEqual([{ name: "chinook" }]);
	} finally {
		await client.close();
	}
});
