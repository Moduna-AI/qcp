import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "qcp-web",
	description: "Local Query Companion web assistant",
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>): React.ReactElement {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	);
}
