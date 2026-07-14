export type ConnectionSecurityWarning = "tls-not-required";

export class PostgresConnectionValidationError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "PostgresConnectionValidationError";
	}
}

export interface ValidatedPostgresConnection {
	readonly databaseUrl: string;
	readonly summary: string;
	readonly warnings: readonly ConnectionSecurityWarning[];
}

export class PostgresConnectionValidator {
	public validate(input: string): ValidatedPostgresConnection {
		const databaseUrl = input.trim();
		if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
			throw new PostgresConnectionValidationError(
				"Use a PostgreSQL URI beginning with postgres:// or postgresql://. Keyword/value connection strings are not supported.",
			);
		}
		if (databaseUrl.includes("#")) {
			throw new PostgresConnectionValidationError(
				"PostgreSQL connection URIs must not include a fragment.",
			);
		}
		assertPercentEncoding(databaseUrl);
		const uri = splitUri(databaseUrl);
		const hosts = parseHosts(uri.authority);
		const parameters = new URLSearchParams(uri.query);
		const sslmode = parameters.get("sslmode")?.toLowerCase();
		if (sslmode === "disable" || sslmode === "allow") {
			throw new PostgresConnectionValidationError(
				"Unsafe TLS setting. Remove sslmode=disable/allow or use sslmode=require.",
			);
		}
		const remote = hosts.some((host) => !isLocalHost(host));
		return {
			databaseUrl,
			summary: describeConnection(hosts, uri.path),
			warnings:
				remote && !isTlsRequired(sslmode, parameters)
					? ["tls-not-required"]
					: [],
		};
	}
}

export function redactDatabaseUrl(value: string): string {
	try {
		const uri = splitUri(value);
		return `${uri.scheme}://${describeConnection(parseHosts(uri.authority), uri.path)}`;
	} catch {
		return "[REDACTED_DATABASE_URL]";
	}
}

export function sanitizeConnectionError(error: unknown): string {
	if (error instanceof PostgresConnectionValidationError) return error.message;
	const message = error instanceof Error ? error.message : String(error);
	const safe = message.replace(
		/postgres(?:ql)?:\/\/[^\s'"<>]+/gi,
		"[REDACTED_DATABASE_URL]",
	);
	if (/password authentication failed|authentication failed/i.test(safe))
		return "Authentication failed. Verify the database username and password.";
	if (/does not exist|unknown database/i.test(safe))
		return "Database not found. Verify the database name.";
	if (/certificate|tls|ssl/i.test(safe))
		return "TLS connection failed. Verify sslmode and the server certificate settings.";
	if (/timeout|timed out/i.test(safe))
		return "Connection timed out. Verify the host, port, and firewall rules.";
	if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|no such host/i.test(safe))
		return "Database host could not be resolved. Verify the hostname and DNS.";
	if (/ECONNREFUSED|connection refused|network|unreachable/i.test(safe))
		return "Database host is unreachable. Verify the host, port, and network access.";
	return safe || "Database connection failed for an unknown reason.";
}

interface UriParts {
	readonly scheme: string;
	readonly authority: string;
	readonly path: string;
	readonly query: string;
}

function splitUri(value: string): UriParts {
	const match = /^(postgres(?:ql)?):\/\/([^/?]*)([^?]*)(?:\?(.*))?$/i.exec(
		value,
	);
	if (!match)
		throw new PostgresConnectionValidationError(
			"Malformed PostgreSQL connection URI.",
		);
	return {
		scheme: match[1].toLowerCase(),
		authority: match[2],
		path: match[3],
		query: match[4] ?? "",
	};
}

function parseHosts(authority: string): string[] {
	const separator = authority.lastIndexOf("@");
	if (separator !== authority.indexOf("@")) {
		throw new PostgresConnectionValidationError(
			"Connection URI credentials must percent-encode @ as %40.",
		);
	}
	const hostList = authority.slice(separator + 1);
	if (!hostList) return [];
	return splitHostList(hostList).map(validateHost);
}

function splitHostList(value: string): string[] {
	const hosts: string[] = [];
	let start = 0;
	let bracketed = false;
	for (let index = 0; index <= value.length; index += 1) {
		const character = value[index];
		if (character === "[") bracketed = true;
		if (character === "]") bracketed = false;
		if ((character === "," && !bracketed) || index === value.length) {
			hosts.push(value.slice(start, index));
			start = index + 1;
		}
	}
	return hosts;
}

function validateHost(value: string): string {
	if (!value || /[\s/@]/.test(value))
		throw new PostgresConnectionValidationError(
			"Connection URI contains an invalid host.",
		);
	const match = value.startsWith("[")
		? /^\[([0-9A-Fa-f:.]+)\](?::(\d+))?$/.exec(value)
		: /^([^:]+?)(?::(\d+))?$/.exec(value);
	if (!match)
		throw new PostgresConnectionValidationError(
			"Connection URI contains an invalid host or port.",
		);
	if (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65_535))
		throw new PostgresConnectionValidationError(
			"Connection URI port must be between 1 and 65535.",
		);
	return match[1].toLowerCase();
}

function assertPercentEncoding(value: string): void {
	if (/%(?![0-9A-Fa-f]{2})/.test(value))
		throw new PostgresConnectionValidationError(
			"Connection URI contains invalid percent-encoding.",
		);
}

function isLocalHost(host: string): boolean {
	return (
		host === "localhost" ||
		host === "::1" ||
		host === "127.0.0.1" ||
		host.startsWith("/")
	);
}
function isTlsRequired(
	sslmode: string | undefined,
	parameters: URLSearchParams,
): boolean {
	return (
		sslmode === "require" ||
		sslmode === "verify-ca" ||
		sslmode === "verify-full" ||
		parameters.get("ssl") === "true"
	);
}
function describeConnection(hosts: readonly string[], path: string): string {
	return `${hosts.length ? hosts.join(",") : "local socket"}${path || "/"}`;
}
