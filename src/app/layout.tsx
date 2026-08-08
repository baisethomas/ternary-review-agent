import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ternary — autonomous code review",
  description: "An internal code review agent with isolated test sandboxes.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
