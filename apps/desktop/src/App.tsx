import {
	AlertTriangle,
	BookOpen,
	Check,
	Clipboard,
	Database,
	FolderOpen,
	Keyboard,
	MessageSquare,
	Plus,
	Send,
	Settings,
	Sparkles,
	SquarePen,
	Terminal,
	X,
} from "lucide-react";
import type { FormEvent, ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	type AssistantApprovalRequest,
	approveAssistantPrompt,
	type DesktopSettingsResponse,
	getDesktopSettings,
	submitAssistantPrompt,
} from "./assistant-bridge";
import {
	type AssistantMessage,
	createApprovalDeniedMessage,
	createMessage,
	createMessageFromResponse,
	formatApprovalType,
	formatSettingsStatus,
} from "./desktop-ui-state";
import {
	createPromptCapture,
	type PromptCapture,
	prependPromptCapture,
	readPromptCaptures,
	writePromptCaptures,
} from "./prompt-capture";

const seededPrompts: PromptCapture[] = [
	{
		id: "seed-slow-queries",
		text: "Explain slow queries on the reporting database.",
		createdAt: "2026-07-01T08:42:00.000Z",
	},
	{
		id: "seed-unused-indexes",
		text: "List unused indexes in public schema.",
		createdAt: "2026-06-30T12:00:00.000Z",
	},
	{
		id: "seed-table-sizes",
		text: "Show table sizes by schema.",
		createdAt: "2026-06-30T10:00:00.000Z",
	},
];

export function App(): ReactElement {
	const [prompt, setPrompt] = useState("");
	const [captures, setCaptures] = useState<PromptCapture[]>([]);
	const [messages, setMessages] = useState<AssistantMessage[]>([]);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [sessionId, setSessionId] = useState(createSessionId);
	const [resolvedApprovalIds, setResolvedApprovalIds] = useState<string[]>([]);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settings, setSettings] = useState<DesktopSettingsResponse | null>(
		null,
	);
	const [settingsError, setSettingsError] = useState<string | null>(null);
	const [isSettingsLoading, setIsSettingsLoading] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const canSubmit = prompt.trim().length > 0 && !isSubmitting;

	useEffect(() => {
		const storedCaptures = readPromptCaptures(window.localStorage);
		setCaptures(storedCaptures);
	}, []);

	useEffect(() => {
		writePromptCaptures(window.localStorage, captures);
	}, [captures]);

	useEffect(() => {
		if (settingsOpen) void loadSettings();
	}, [settingsOpen]);

	const visiblePrompts = useMemo<PromptCapture[]>(() => {
		return captures.length > 0 ? captures : seededPrompts;
	}, [captures]);

	async function loadSettings(): Promise<void> {
		setIsSettingsLoading(true);
		setSettingsError(null);

		try {
			const nextSettings = await getDesktopSettings();
			setSettings(nextSettings);
		} catch (err: unknown) {
			setSettingsError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsSettingsLoading(false);
		}
	}

	async function handleSubmit(
		event: FormEvent<HTMLFormElement>,
	): Promise<void> {
		event.preventDefault();

		const capture = createPromptCapture(prompt);

		if (capture === null) {
			return;
		}

		const submittedPrompt = capture.text;
		setCaptures((currentCaptures) =>
			prependPromptCapture(currentCaptures, capture),
		);
		setPrompt("");
		setMessages((currentMessages) => [
			...currentMessages,
			createMessage({
				role: "user",
				text: submittedPrompt,
				meta: "You",
				tone: "normal",
			}),
		]);
		setIsSubmitting(true);

		try {
			const response = await submitAssistantPrompt(submittedPrompt, sessionId);
			setMessages((currentMessages) => [
				...currentMessages,
				createMessageFromResponse(response),
			]);
		} finally {
			setIsSubmitting(false);
			window.requestAnimationFrame(() => inputRef.current?.focus());
		}
	}

	async function handleApprove(
		approval: AssistantApprovalRequest,
	): Promise<void> {
		setResolvedApprovalIds((currentIds) => [...currentIds, approval.requestId]);
		setIsSubmitting(true);

		try {
			const response = await approveAssistantPrompt(approval, sessionId);
			setMessages((currentMessages) => [
				...currentMessages,
				createMessageFromResponse(response),
			]);
		} finally {
			setIsSubmitting(false);
			window.requestAnimationFrame(() => inputRef.current?.focus());
		}
	}

	function handleDeny(approval: AssistantApprovalRequest): void {
		setResolvedApprovalIds((currentIds) => [...currentIds, approval.requestId]);
		setMessages((currentMessages) => [
			...currentMessages,
			createApprovalDeniedMessage(approval),
		]);
		inputRef.current?.focus();
	}

	function clearHistory(): void {
		setCaptures([]);
		window.localStorage.removeItem("qcp.desktop.promptCaptures.v1");
		inputRef.current?.focus();
	}

	function startNewSession(): void {
		setMessages([]);
		setPrompt("");
		setResolvedApprovalIds([]);
		setSessionId(createSessionId());
		inputRef.current?.focus();
	}

	return (
		<main className="app-shell">
			<aside className="sidebar" aria-label="Prompt sessions">
				<div className="brand-row">
					<div className="brand-mark" aria-hidden="true">
						<Terminal size={22} strokeWidth={2} />
					</div>
					<div>
						<p className="brand-name">qcp</p>
						<p className="brand-subtitle">PostgreSQL assistant</p>
					</div>
				</div>

				<button
					className="new-session-button"
					type="button"
					onClick={startNewSession}
				>
					<Plus size={17} />
					<span>New session</span>
				</button>

				<section className="sidebar-section" aria-labelledby="recent-label">
					<div className="section-label-row">
						<p id="recent-label" className="section-label">
							Recent
						</p>
						<SquarePen size={16} aria-hidden="true" />
					</div>
					<nav className="prompt-list">
						{visiblePrompts.map((capture) => (
							<button
								className="prompt-list-item"
								key={capture.id}
								onClick={() => setPrompt(capture.text)}
								type="button"
							>
								<MessageSquare size={16} aria-hidden="true" />
								<span>{capture.text}</span>
								<time>{formatRelativeTime(capture.createdAt)}</time>
							</button>
						))}
					</nav>
				</section>

				<div className="sidebar-footer">
					<button
						className="sidebar-link"
						type="button"
						onClick={() => setSettingsOpen(true)}
					>
						<Settings size={17} />
						<span>Settings</span>
					</button>
					<div
						className="connection-pill"
						role="status"
						aria-label={isSubmitting ? "qcp is thinking" : "qcp is ready"}
					>
						<span className="status-dot" aria-hidden="true" />
						<div>
							<p>qcp local</p>
							<span>{isSubmitting ? "Thinking" : "Ready"}</span>
						</div>
					</div>
				</div>
			</aside>

			<section className="workspace" aria-label="Assistant workspace">
				<header className="topbar">
					<div className="toolbar-group">
						<button
							className="toolbar-button"
							type="button"
							onClick={startNewSession}
						>
							<Plus size={17} />
							<span>New session</span>
						</button>
						<button className="toolbar-button" type="button">
							<FolderOpen size={17} />
							<span>Open</span>
						</button>
					</div>
					<div className="toolbar-group">
						<button className="toolbar-button" type="button">
							<Keyboard size={17} />
							<span>Shortcuts</span>
						</button>
						<button className="toolbar-button" type="button">
							<BookOpen size={17} />
							<span>Docs</span>
						</button>
						<button
							className="toolbar-button"
							type="button"
							onClick={() => setSettingsOpen(true)}
						>
							<Settings size={17} />
							<span>Settings</span>
						</button>
					</div>
				</header>

				<div className="workspace-center">
					{messages.length === 0 ? (
						<div className="empty-state" aria-live="polite">
							<div className="empty-icon" aria-hidden="true">
								<Sparkles size={24} />
							</div>
							<h1>Focused workspace</h1>
							<p>Ask qcp about your PostgreSQL database.</p>
						</div>
					) : (
						<div className="message-list" aria-live="polite">
							{messages.map((message) => (
								<MessageRow
									key={message.id}
									message={message}
									resolvedApprovalIds={resolvedApprovalIds}
									isSubmitting={isSubmitting}
									onApprove={handleApprove}
									onDeny={handleDeny}
								/>
							))}
							{isSubmitting ? (
								<article className="message-row message-row-assistant">
									<div className="message-avatar" aria-hidden="true">
										<Sparkles size={17} />
									</div>
									<div className="message-body">
										<div className="message-meta">qcp</div>
										<p>Thinking...</p>
									</div>
								</article>
							) : null}
						</div>
					)}
				</div>

				<section
					className="composer-zone"
					aria-label="Assistant prompt composer"
				>
					<form
						className="prompt-composer"
						onSubmit={handleSubmit}
						id="prompt-bar"
					>
						<label className="sr-only" htmlFor="assistant-prompt">
							Assistant prompt
						</label>
						<div className="prompt-input-row">
							<Terminal
								className="prompt-prefix"
								size={22}
								aria-hidden="true"
							/>
							<textarea
								ref={inputRef}
								id="assistant-prompt"
								value={prompt}
								onChange={(event) => setPrompt(event.currentTarget.value)}
								placeholder="Ask qcp anything..."
								rows={1}
								disabled={isSubmitting}
							/>
							<button
								className="send-button"
								type="submit"
								disabled={!canSubmit}
								aria-label="Ask qcp"
							>
								<Send size={20} />
							</button>
						</div>
						<div className="composer-meta">
							<div className="connection-status">
								<Database size={17} aria-hidden="true" />
								<span>qcp local</span>
								<span className="status-dot" aria-hidden="true" />
								<span>{isSubmitting ? "Thinking" : "Ready"}</span>
							</div>
							<div className="submit-hint">
								<span>Enter to ask</span>
								<kbd>Enter</kbd>
							</div>
						</div>
					</form>
					<div className="history-row">
						<p>Recent prompts</p>
						<button type="button" onClick={clearHistory}>
							Clear history
						</button>
					</div>
				</section>
			</section>

			{settingsOpen ? (
				<SettingsDrawer
					settings={settings}
					error={settingsError}
					isLoading={isSettingsLoading}
					onRefresh={loadSettings}
					onClose={() => setSettingsOpen(false)}
				/>
			) : null}
		</main>
	);
}

interface MessageRowProps {
	readonly message: AssistantMessage;
	readonly resolvedApprovalIds: readonly string[];
	readonly isSubmitting: boolean;
	readonly onApprove: (approval: AssistantApprovalRequest) => Promise<void>;
	readonly onDeny: (approval: AssistantApprovalRequest) => void;
}

function MessageRow(props: MessageRowProps): ReactElement {
	const resolved = props.message.approval
		? props.resolvedApprovalIds.includes(props.message.approval.requestId)
		: false;

	return (
		<article
			className={`message-row message-row-${props.message.role} message-tone-${props.message.tone}`}
		>
			<div className="message-avatar" aria-hidden="true">
				{props.message.tone === "error" ? (
					<AlertTriangle size={17} />
				) : props.message.role === "user" ? (
					<Terminal size={17} />
				) : (
					<Sparkles size={17} />
				)}
			</div>
			<div className="message-body">
				<div className="message-meta">{props.message.meta}</div>
				<p>{props.message.text}</p>
				{props.message.approval ? (
					<ApprovalPanel
						approval={props.message.approval}
						resolved={resolved}
						isSubmitting={props.isSubmitting}
						onApprove={props.onApprove}
						onDeny={props.onDeny}
					/>
				) : null}
			</div>
		</article>
	);
}

interface ApprovalPanelProps {
	readonly approval: AssistantApprovalRequest;
	readonly resolved: boolean;
	readonly isSubmitting: boolean;
	readonly onApprove: (approval: AssistantApprovalRequest) => Promise<void>;
	readonly onDeny: (approval: AssistantApprovalRequest) => void;
}

function ApprovalPanel(props: ApprovalPanelProps): ReactElement {
	return (
		<div className="approval-panel">
			<div className="approval-reasons">
				{props.approval.reasons.map((reason) => (
					<div
						className="approval-reason"
						key={`${reason.type}-${reason.detail}`}
					>
						<span>{formatApprovalType(reason.type)}</span>
						<p>{reason.detail}</p>
					</div>
				))}
			</div>
			<pre className="sql-preview">{props.approval.sql}</pre>
			<div className="approval-actions">
				<button
					type="button"
					onClick={() => void props.onApprove(props.approval)}
					disabled={props.resolved || props.isSubmitting}
				>
					<Check size={16} />
					<span>Approve</span>
				</button>
				<button
					type="button"
					onClick={() => props.onDeny(props.approval)}
					disabled={props.resolved || props.isSubmitting}
				>
					<X size={16} />
					<span>Deny</span>
				</button>
			</div>
		</div>
	);
}

interface SettingsDrawerProps {
	readonly settings: DesktopSettingsResponse | null;
	readonly error: string | null;
	readonly isLoading: boolean;
	readonly onRefresh: () => Promise<void>;
	readonly onClose: () => void;
}

function SettingsDrawer(props: SettingsDrawerProps): ReactElement {
	return (
		<div className="settings-backdrop" role="presentation">
			<aside className="settings-drawer" aria-label="Desktop settings">
				<header className="settings-header">
					<div>
						<p className="section-label">Settings</p>
						<h2>Desktop runtime</h2>
					</div>
					<button
						type="button"
						onClick={props.onClose}
						aria-label="Close settings"
					>
						<X size={18} />
					</button>
				</header>

				{props.error ? <p className="settings-error">{props.error}</p> : null}
				{props.isLoading ? <p className="settings-muted">Loading...</p> : null}
				{props.settings ? <SettingsContent settings={props.settings} /> : null}

				<div className="settings-actions">
					<button type="button" onClick={() => void props.onRefresh()}>
						Refresh
					</button>
				</div>
			</aside>
		</div>
	);
}

function SettingsContent({
	settings,
}: {
	readonly settings: DesktopSettingsResponse;
}): ReactElement {
	const actionableCommand =
		settings.schema.status === "ready" ? null : settings.schema.command;

	return (
		<div className="settings-content">
			<div className="settings-status">
				<span className="status-dot" aria-hidden="true" />
				<div>
					<p>{formatSettingsStatus(settings)}</p>
					<span>qcp {settings.appVersion}</span>
				</div>
			</div>

			<div className="settings-grid">
				<SettingsItem label="Runtime" value={settings.runtimeMode} />
				<SettingsItem label="Provider" value={settings.provider.name} />
				<SettingsItem label="Model" value={settings.provider.model} />
				<SettingsItem
					label="Safe mode"
					value={settings.safeMode ? "On" : "Off"}
				/>
				<SettingsItem
					label="Telemetry"
					value={settings.telemetry ? "On" : "Off"}
				/>
				<SettingsItem
					label="Connection"
					value={settings.activeConnection?.name ?? "Not configured"}
				/>
				<SettingsItem
					label="Database type"
					value={settings.activeConnection?.databaseType ?? "Unknown"}
				/>
				<SettingsItem
					label="Schema"
					value={
						settings.schema.status === "ready"
							? `${settings.schema.databaseName} · ${settings.schema.tableCount} tables`
							: settings.schema.message
					}
				/>
			</div>

			{actionableCommand ? (
				<div className="settings-command">
					<p>Run this in your terminal:</p>
					<div>
						<code>{actionableCommand}</code>
						<button
							type="button"
							onClick={() => void copyText(actionableCommand)}
							aria-label={`Copy ${actionableCommand}`}
						>
							<Clipboard size={16} />
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}

function SettingsItem({
	label,
	value,
}: {
	readonly label: string;
	readonly value: string;
}): ReactElement {
	return (
		<div className="settings-item">
			<span>{label}</span>
			<p>{value}</p>
		</div>
	);
}

async function copyText(text: string): Promise<void> {
	await navigator.clipboard?.writeText(text);
}

function createSessionId(): string {
	return createMessageId().replace("message-", "session-");
}

function createMessageId(): string {
	return (
		globalThis.crypto?.randomUUID?.() ?? `message-${Date.now().toString(36)}`
	);
}

function formatRelativeTime(createdAt: string): string {
	const createdTime = Date.parse(createdAt);

	if (Number.isNaN(createdTime)) {
		return "now";
	}

	const minutes = Math.max(0, Math.round((Date.now() - createdTime) / 60000));

	if (minutes < 1) {
		return "now";
	}

	if (minutes < 60) {
		return `${minutes}m`;
	}

	const hours = Math.round(minutes / 60);

	if (hours < 24) {
		return `${hours}h`;
	}

	return `${Math.round(hours / 24)}d`;
}
