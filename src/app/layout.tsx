import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ternary — autonomous code review",
  description: "An internal code review agent with isolated test sandboxes.",
};

const themeBoot = `try{if(localStorage.getItem("ternary-theme")==="light")document.documentElement.setAttribute("data-theme","light")}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body><ClerkProvider>{children}</ClerkProvider></body>
    </html>
  );
}
