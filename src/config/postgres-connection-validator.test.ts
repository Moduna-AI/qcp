import { describe, expect, test } from "bun:test";
import {
	PostgresConnectionValidationError,
	PostgresConnectionValidator,
	redactDatabaseUrl,
	sanitizeConnectionError,
} from "./postgres-connection-validator.js";

const validator = new PostgresConnectionValidator();

describe("PostgresConnectionValidator", () => {
	test("accepts libpq URI forms without exposing credentials", () => {
		expect(
			validator.validate(
				"postgresql://user:p%40ss@[::1]:5432,db.example.com:5433/app?sslmode=require",
			),
		).toEqual({
			databaseUrl:
				"postgresql://user:p%40ss@[::1]:5432,db.example.com:5433/app?sslmode=require",
			summary: "::1,db.example.com/app",
			warnings: [],
		});
		expect(
			validator.validate("postgresql:///app?host=%2Fvar%2Flib%2Fpostgresql")
				.warnings,
		).toEqual([]);
	});

	test("warns when remote TLS is not required", () => {
		expect(
			validator.validate("postgres://db.example.com/app").warnings,
		).toEqual(["tls-not-required"]);
	});

	test.each([
		"host=localhost dbname=app",
		"postgres://db/app#fragment",
		"postgres://db:70000/app",
		"postgres://db/%ZZ",
		"postgres://db/app?sslmode=disable",
	])("rejects unsafe or invalid input: %s", (value) => {
		expect(() => validator.validate(value)).toThrow(
			PostgresConnectionValidationError,
		);
	});

	test("redacts URLs and classifies connection errors", () => {
		expect(
			redactDatabaseUrl(
				"postgres://user:secret@db.example.com/app?token=secret",
			),
		).toBe("postgres://db.example.com/app");
		expect(
			sanitizeConnectionError(
				new Error(
					"password authentication failed for postgres://user:secret@db/app",
				),
			),
		).toBe("Authentication failed. Verify the database username and password.");
	});
});
