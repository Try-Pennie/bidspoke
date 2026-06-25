import type { Config } from 'tailwindcss'
import defaultTheme from 'tailwindcss/defaultTheme'
import typography from '@tailwindcss/typography'

const config: Config = {
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-pp-mori)', ...defaultTheme.fontFamily.sans],
        mono: ['var(--font-geist-mono)', ...defaultTheme.fontFamily.mono],
      },
      colors: {
        navy: '#1D212F',
        graphite: '#343434',
        beige: '#F9F6F0',
        'p-blue': {
          light: '#ECF8FF',
          DEFAULT: '#82D0FF',
          // Darkened from #439FE1 so white text clears WCAG AA (5.04:1). Used as
          // the primary action color (buttons, active pills/tabs). See contrast.test.ts.
          dark: '#1B72BA',
        },
        'p-green': {
          light: '#F0F9F1',
          DEFAULT: '#86E7B3',
          dark: '#55CF90',
        },
        'p-yellow': {
          light: '#FFF7E7',
          DEFAULT: '#FFD073',
          dark: '#D69938',
        },
        'p-peach': {
          light: '#FFF5F2',
          DEFAULT: '#FF966F',
          dark: '#E7704C',
        },
      },
    },
  },
  plugins: [typography],
}

export default config
