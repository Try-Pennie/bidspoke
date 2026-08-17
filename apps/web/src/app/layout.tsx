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

/**
 * The commit this build was made from, rendered into every page so the live site
 * can say what it is serving (#804).
 *
 * NEXT_PUBLIC_* is inlined at compile time, so this is fixed when the Pages build
 * runs and cannot drift afterwards. A build with no stamp renders `unknown`,
 * which the drift check reads as unstamped rather than as a commit: that is the
 * signal that stamping itself has broken, and it must never be compared against
 * history as if it were a real commit.
 *
 * It goes on the ROOT layout, not one endpoint, because a Pages deploy propagates
 * per route. A single version endpoint would report the new build while other
 * routes were still serving the old one.
 */
const BUILD_COMMIT = process.env.NEXT_PUBLIC_COMMIT_SHA || 'unknown'

export const metadata: Metadata = {
  title: 'Bidspoke',
  description: 'Visual workflow builder and execution engine',
  icons: {
    icon: [
      { url: '/icon-light.png', media: '(prefers-color-scheme: light)' },
      { url: '/icon-dark.png', media: '(prefers-color-scheme: dark)' },
    ],
  },
  // Renders <meta name="bidspoke-commit" content="..."/> into every page.
  other: { 'bidspoke-commit': BUILD_COMMIT },
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
