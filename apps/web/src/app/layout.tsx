import type { Metadata } from 'next'
import localFont from 'next/font/local'
import { GeistMono } from 'geist/font/mono'
import './globals.css'
import NumberInputWheelGuard from '@/components/NumberInputWheelGuard'

const ppMori = localFont({
  src: [
    { path: './fonts/PPMori-Extralight.otf', weight: '200', style: 'normal' },
    { path: './fonts/PPMori-ExtralightItalic.otf', weight: '200', style: 'italic' },
    { path: './fonts/PPMori-Regular.otf', weight: '400', style: 'normal' },
    { path: './fonts/PPMori-RegularItalic.otf', weight: '400', style: 'italic' },
    { path: './fonts/PPMori-SemiBold.otf', weight: '600', style: 'normal' },
    { path: './fonts/PPMori-SemiBoldItalic.otf', weight: '600', style: 'italic' },
  ],
  variable: '--font-pp-mori',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Bidspoke',
  description: 'Visual workflow builder and execution engine',
  icons: {
    icon: [
      { url: '/icon-light.png', media: '(prefers-color-scheme: light)' },
      { url: '/icon-dark.png', media: '(prefers-color-scheme: dark)' },
    ],
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${ppMori.variable} ${GeistMono.variable}`}>
      <body className="bg-beige font-sans text-graphite antialiased">
        <NumberInputWheelGuard />
        {children}
      </body>
    </html>
  )
}
