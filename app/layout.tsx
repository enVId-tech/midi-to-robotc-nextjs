import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MIDI → RobotC Converter",
  description: "Convert MIDI files into LEGO NXT RobotC code",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
