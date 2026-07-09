"use client";

import { useState } from "react";

interface LoginFormProps {
	readonly setupRequired: boolean;
}

export function LoginForm({
	setupRequired,
}: LoginFormProps): React.ReactElement {
	const [passcode, setPasscode] = useState("");
	const [confirmPasscode, setConfirmPasscode] = useState("");
	const [error, setError] = useState<string | undefined>();
	const [loading, setLoading] = useState(false);

	async function submit(
		event: React.FormEvent<HTMLFormElement>,
	): Promise<void> {
		event.preventDefault();
		const normalizedPasscode = passcode.trim();
		const normalizedConfirmPasscode = confirmPasscode.trim();
		if (setupRequired && !/^\d{4}$/.test(normalizedPasscode)) {
			setError("Passcode must be exactly 4 digits.");
			return;
		}
		if (setupRequired && normalizedPasscode !== normalizedConfirmPasscode) {
			setError("Passcodes do not match.");
			return;
		}
		setLoading(true);
		setError(undefined);
		try {
			const response = await fetch(
				setupRequired ? "/api/auth/setup" : "/api/auth/login",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ passcode: normalizedPasscode }),
				},
			);
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as {
					error?: string;
				};
				setError(body.error ?? "Login failed.");
				setLoading(false);
				return;
			}
			window.location.reload();
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			setError(`Request failed: ${message}`);
			setLoading(false);
		}
	}

	return (
		<main className="login">
			<section className="panel login-card">
				<h1>qcp-web</h1>
				<p>
					{setupRequired
						? "Choose a 4 digit local qcp-web passcode."
						: "Local assistant access is gated by your qcp-web passcode."}
				</p>
				<form onSubmit={submit}>
					<input
						aria-label="qcp-web passcode"
						className="input"
						inputMode={setupRequired ? "numeric" : undefined}
						maxLength={setupRequired ? 4 : undefined}
						onChange={(event) =>
							setPasscode(
								normalizePasscodeInput(event.target.value, setupRequired),
							)
						}
						placeholder={setupRequired ? "Create passcode" : "Local passcode"}
						type="password"
						value={passcode}
					/>
					{setupRequired ? (
						<>
							<div style={{ height: 10 }} />
							<input
								aria-label="Confirm qcp-web passcode"
								className="input"
								inputMode="numeric"
								maxLength={4}
								onChange={(event) =>
									setConfirmPasscode(
										normalizePasscodeInput(event.target.value, true),
									)
								}
								placeholder="Confirm passcode"
								type="password"
								value={confirmPasscode}
							/>
						</>
					) : null}
					<div style={{ height: 10 }} />
					<button
						className="button"
						disabled={
							loading ||
							!passcode ||
							(setupRequired &&
								(!/^\d{4}$/.test(passcode) ||
									!/^\d{4}$/.test(confirmPasscode) ||
									passcode !== confirmPasscode))
						}
						type="submit"
					>
						{loading
							? setupRequired
								? "Creating..."
								: "Checking..."
							: setupRequired
								? "Create passcode"
								: "Open assistant"}
					</button>
				</form>
				{error ? <p className="error">{error}</p> : null}
			</section>
		</main>
	);
}

function normalizePasscodeInput(value: string, setupRequired: boolean): string {
	if (!setupRequired) return value;
	return value.replace(/\D/g, "").slice(0, 4);
}
