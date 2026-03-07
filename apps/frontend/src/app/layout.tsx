import React from 'react';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Root layout must return html and body tags in Next.js App Router
  // The locale layout will be rendered as children
  return children;
}
