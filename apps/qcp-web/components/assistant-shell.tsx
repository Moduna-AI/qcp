"use client";

import type { QcpWebConnectionSummary } from "@moduna/qcp/web";
import { useCallback, useEffect, useMemo, useState } from "react";
import { parseStreamEvent, type QcpWebStreamEvent } from "~/lib/api";

interface ChatMessage {
	readonly id: string;
	readonly role: "user" | "assistant";
	readonly text: string;
}

interface PendingApproval {
	readonly runId: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly args?: unknown;
}

type SafetyLevel = "low" | "standard" | "strict";

export function AssistantShell(): React.ReactElement {
	const [connections, setConnections] = useState<QcpWebConnectionSummary[]>([]);
	const [selectedConnection, setSelectedConnection] = useState<
		string | undefined
	>();
	const [safetyLevel, setSafetyLevel] = useState<SafetyLevel>("standard");
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [input, setInput] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [pendingApproval, setPendingApproval] = useState<
		PendingApproval | undefined
	>();

	const activeConnection = useMemo(
		() =>
			connections.find(
				(connection) => connection.name === selectedConnection,
			) ??
			connections.find((connection) => connection.active) ??
			connections[0],
		[connections, selectedConnection],
	);

	const loadConnections = useCallback(async (): Promise<void> => {
		const response = await fetch("/api/qcp/connections");
		if (!response.ok) {
			setError("Could not load qcp connections.");
			return;
		}
		const body = (await response.json()) as {
			connections: QcpWebConnectionSummary[];
		};
		setConnections(body.connections);
		setSelectedConnection(
			body.connections.find((connection) => connection.active)?.name ??
				body.connections[0]?.name,
		);
	}, []);

	const loadSafetyConfig = useCallback(async (): Promise<void> => {
		const response = await fetch("/api/qcp/safety");
		if (!response.ok) return;
		const body = (await response.json()) as { safetyLevel: SafetyLevel };
		setSafetyLevel(body.safetyLevel);
	}, []);

	useEffect(() => {
		void loadConnections();
		void loadSafetyConfig();
	}, [loadConnections, loadSafetyConfig]);

	async function changeSafetyLevel(
		nextSafetyLevel: SafetyLevel,
	): Promise<void> {
		const passcode =
			nextSafetyLevel === "low" && safetyLevel !== "low"
				? window.prompt(
						"Enter your qcp-web passcode to confirm the safety downgrade.",
					)
				: undefined;
		if (nextSafetyLevel === "low" && safetyLevel !== "low" && !passcode) {
			return;
		}
		setSafetyLevel(nextSafetyLevel);
		const response = await fetch("/api/qcp/safety", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ safetyLevel: nextSafetyLevel, passcode }),
		});
		if (!response.ok) {
			setError("Could not update safety level.");
			await loadSafetyConfig();
		}
	}

	async function logout(): Promise<void> {
		await fetch("/api/auth/logout", { method: "POST" });
		window.location.reload();
	}

	async function submit(
		event: React.FormEvent<HTMLFormElement>,
	): Promise<void> {
		event.preventDefault();
		const message = input.trim();
		if (!message || loading) return;

		setInput("");
		setError(undefined);
		setPendingApproval(undefined);
		const assistantId = crypto.randomUUID();
		setMessages((current) => [
			...current,
			{ id: crypto.randomUUID(), role: "user", text: message },
			{ id: assistantId, role: "assistant", text: "" },
		]);
		setLoading(true);
		await postAndReadStream(
			"/api/chat",
			{
				message,
				connectionName: activeConnection?.name,
				safetyLevel,
			},
			assistantId,
		);
		setLoading(false);
	}

	async function answerApproval(approve: boolean): Promise<void> {
		if (!pendingApproval) return;
		setLoading(true);
		setError(undefined);
		const assistantId = crypto.randomUUID();
		setMessages((current) => [
			...current,
			{
				id: assistantId,
				role: "assistant",
				text: approve
					? "Approved. Continuing...\n\n"
					: "Declined. Continuing...\n\n",
			},
		]);
		const approval = pendingApproval;
		setPendingApproval(undefined);
		await postAndReadStream(
			"/api/chat/approve",
			{
				runId: approval.runId,
				toolCallId: approval.toolCallId,
				approve,
			},
			assistantId,
		);
		setLoading(false);
	}

	async function postAndReadStream(
		url: string,
		body: Record<string, unknown>,
		assistantId: string,
	): Promise<void> {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok || !response.body) {
			setError("Assistant request failed.");
			return;
		}
		await readEventStream(response.body, (event) => {
			if (event.type === "text") {
				appendAssistantText(assistantId, event.text);
			}
			if (event.type === "approval") {
				setPendingApproval(event);
			}
			if (event.type === "error") {
				setError(event.error);
				appendAssistantText(assistantId, event.error);
			}
		});
	}

	function appendAssistantText(assistantId: string, text: string): void {
		setMessages((current) =>
			current.map((message) =>
				message.id === assistantId
					? { ...message, text: `${message.text}${text}` }
					: message,
			),
		);
	}

	return (
		<div className="shell">
			<aside className="sidebar">
				<div className="brand">
					<h1 className="mono">◆ qcp-web</h1>
					<span className="tag">localhost</span>
				</div>

				<div className="section-title">Connections</div>
				<div className="connection-list">
					{connections.length === 0 ? (
						<div className="connection">
							<strong>No aliases</strong>
							<span>Run qcp connect to register a database.</span>
						</div>
					) : (
						connections.map((connection) => (
							<button
								className={`connection ${
									connection.name === activeConnection?.name ? "active" : ""
								}`}
								key={connection.id}
								onClick={() => setSelectedConnection(connection.name)}
								type="button"
							>
								<strong>{connection.name}</strong>
								<span>
									{connection.databaseType} ·{" "}
									{connection.schemaAvailable
										? `${connection.databaseName ?? "schema"} · ${
												connection.tableCount ?? 0
											} tables`
										: "schema missing"}
								</span>
							</button>
						))
					)}
				</div>

				<div className="section-title">Status</div>
				<div className="status">
					<p>
						Low skips selected approvals only. Privacy, function, tenant, and
						read-only protections remain enforced.
					</p>
					<div className="row">
						<strong>Active database</strong>
						<span>{activeConnection?.name ?? "not configured"}</span>
					</div>
					<div className="row">
						<strong>Schema</strong>
						<span>
							{activeConnection?.schemaAvailable
								? "indexed"
								: "missing; run qcp schema scan"}
						</span>
					</div>
					<div className="row">
						<strong>Safety</strong>
						<span>{safetyLevel}</span>
					</div>
				</div>

				<div className="section-title">Safety Level</div>
				<div className="status">
					<label className="field">
						<span>Mode</span>
						<select
							className="input"
							onChange={(event) =>
								void changeSafetyLevel(event.target.value as SafetyLevel)
							}
							value={safetyLevel}
						>
							<option value="low">Low</option>
							<option value="standard">Standard</option>
							<option value="strict">Strict</option>
						</select>
					</label>
				</div>
			</aside>

			<main className="main">
				<header className="topbar">
					<div>
						<h2>{activeConnection?.name ?? "Query Companion"}</h2>
						<p>
							{activeConnection?.schemaAvailable
								? "Ask a natural-language question against the selected qcp alias."
								: "Schema not found. Run qcp schema scan before chatting."}
						</p>
					</div>
					<button className="button secondary" onClick={logout} type="button">
						Log out
					</button>
				</header>

				<section className="messages">
					{messages.length === 0 ? (
						<div className="message">
							<div className="label mono">assistant</div>
							Ask about tables, relationships, counts, trends, or query plans.
							qcp-web uses the same local qcp config and Mastra agents as the
							CLI.
						</div>
					) : (
						messages.map((message) => (
							<div className={`message ${message.role}`} key={message.id}>
								<div className="label mono">{message.role}</div>
								{message.text || "Thinking..."}
							</div>
						))
					)}
					{pendingApproval ? (
						<div className="approval">
							<div className="label mono">approval required</div>
							<strong>{pendingApproval.toolName ?? "Database tool"}</strong>
							<pre>{JSON.stringify(pendingApproval.args ?? {}, null, 2)}</pre>
							<div className="approval-actions">
								<button
									className="button"
									onClick={() => void answerApproval(true)}
									type="button"
								>
									Approve
								</button>
								<button
									className="button danger"
									onClick={() => void answerApproval(false)}
									type="button"
								>
									Decline
								</button>
							</div>
						</div>
					) : null}
					{error ? <p className="error">{error}</p> : null}
				</section>

				<section className="composer">
					<form onSubmit={submit}>
						<input
							className="input"
							disabled={!activeConnection?.schemaAvailable || loading}
							onChange={(event) => setInput(event.target.value)}
							placeholder="Ask qcp about this database..."
							value={input}
						/>
						<button
							className="button"
							disabled={
								!input.trim() || !activeConnection?.schemaAvailable || loading
							}
							type="submit"
						>
							Send
						</button>
					</form>
				</section>
			</main>
		</div>
	);
}

async function readEventStream(
	body: ReadableStream<Uint8Array>,
	onEvent: (event: QcpWebStreamEvent) => void,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const parts = buffer.split("\n\n");
		buffer = parts.pop() ?? "";
		for (const part of parts) {
			const event = parseStreamEvent(part.trim());
			if (event) onEvent(event);
		}
	}

	if (buffer.trim()) {
		const event = parseStreamEvent(buffer.trim());
		if (event) onEvent(event);
	}
}
