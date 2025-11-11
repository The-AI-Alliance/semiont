import React from 'react';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Just pass through children - locale layout handles <html> and <body> tags
  return children;
}
