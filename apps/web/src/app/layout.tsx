import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Bidspoke',
  description: 'Visual workflow builder and execution engine',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
