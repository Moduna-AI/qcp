"use client";

import { useChat } from "@ai-sdk/react";
import type { QcpWebConnectionSummary } from "@moduna/qcp/web";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChartCard } from "~/components/chart-card";
import {
	type QcpWebApprovalData,
	type QcpWebUIMessage,
	qcpWebDataPartSchemas,
} from "~/lib/api";
import { readQcpWebUIMessageStream } from "~/lib/ui-stream";

type SafetyLevel = "low" | "standard" | "strict";

export function AssistantShell(): React.ReactElement {
	const [connections, setConnections] = useState<QcpWebConnectionSummary[]>([]);
	const [selectedConnection, setSelectedConnection] = useState<
		string | undefined
	>();
	const [safetyLevel, setSafetyLevel] = useState<SafetyLevel>("standard");
	const [input, setInput] = useState("");
	const [localError, setLocalError] = useState<string | undefined>();
	const [continuingApproval, setContinuingApproval] = useState(false);
	const [pendingApproval, setPendingApproval] = useState<
		QcpWebApprovalData | undefined
	>();

	const transport = useMemo(
		() =>
			new DefaultChatTransport<QcpWebUIMessage>({
				api: "/api/chat",
				prepareSendMessagesRequest: ({ messages, body }) => ({
					body: {
						...body,
						messages: messages.slice(-1),
					},
				}),
			}),
		[],
	);
	const {
		error: chatError,
		messages,
		sendMessage,
		setMessages,
		status,
	} = useChat<QcpWebUIMessage>({
		transport,
		dataPartSchemas: qcpWebDataPartSchemas,
		onData: (part) => {
			if (part.type === "data-approval") setPendingApproval(part.data);
		},
	});

	const activeConnection = useMemo(
		() =>
			connections.find(
				(connection) => connection.name === selectedConnection,
			) ??
			connections.find((connection) => connection.active) ??
			connections[0],
		[connections, selectedConnection],
	);
	const loading =
		status === "submitted" || status === "streaming" || continuingApproval;

	const loadConnections = useCallback(async (): Promise<void> => {
		const response = await fetch("/api/qcp/connections");
		if (!response.ok) {
			setLocalError("Could not load qcp connections.");
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
		if (nextSafetyLevel === "low" && safetyLevel !== "low" && !passcode) return;

		setSafetyLevel(nextSafetyLevel);
		const response = await fetch("/api/qcp/safety", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ safetyLevel: nextSafetyLevel, passcode }),
		});
		if (!response.ok) {
			setLocalError("Could not update safety level.");
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
		const text = input.trim();
		if (!text || loading) return;

		setInput("");
		setLocalError(undefined);
		setPendingApproval(undefined);
		await sendMessage(
			{ text },
			{
				body: {
					connectionName: activeConnection?.name,
					safetyLevel,
				},
			},
		);
	}

	async function answerApproval(approve: boolean): Promise<void> {
		if (!pendingApproval || continuingApproval) return;
		const approval = pendingApproval;
		const assistantId = crypto.randomUUID();
		const initialMessage: QcpWebUIMessage = {
			id: assistantId,
			role: "assistant",
			parts: [],
		};

		setPendingApproval(undefined);
		setLocalError(undefined);
		setContinuingApproval(true);
		setMessages((current) => [...current, initialMessage]);

		try {
			const response = await fetch(
				approve ? "/api/chat/approve" : "/api/chat/decline",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						runId: approval.runId,
						toolCallId: approval.toolCallId,
						approve,
					}),
				},
			);
			if (!response.ok || !response.body) {
				setLocalError("Assistant request failed.");
				return;
			}

			await readQcpWebUIMessageStream(
				response.body,
				initialMessage,
				(message) => {
					setMessages((current) =>
						current.map((existing) =>
							existing.id === assistantId ? message : existing,
						),
					);
					const nextApproval = message.parts.find(
						(part) => part.type === "data-approval",
					);
					if (nextApproval?.type === "data-approval") {
						setPendingApproval(nextApproval.data);
					}
				},
			);
		} catch {
			setLocalError("Assistant request failed.");
		} finally {
			setContinuingApproval(false);
		}
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
							<MessageView key={message.id} message={message} />
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
					{localError || chatError ? (
						<p className="error">
							{localError ?? chatError?.message ?? "Assistant request failed."}
						</p>
					) : null}
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

function MessageView({
	message,
}: {
	readonly message: QcpWebUIMessage;
}): React.ReactElement {
	const chartPart = message.parts.find((part) => part.type === "data-chart");
	const text = message.parts
		.filter((part) => part.type === "text")
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");

	return (
		<div className={`message ${message.role}`}>
			<div className="label mono">{message.role}</div>
			{chartPart?.type === "data-chart" ? (
				<ChartCard chart={chartPart.data} />
			) : (
				text || "Thinking..."
			)}
		</div>
	);
}
