import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    // lib/ holds class-name CONFIG (e.g. the landing-tile colors in
    // lib/nav-links.ts) — without scanning it, Tailwind purges any class used
    // only there (the whited-out landing tiles bug).
    './lib/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      // Turnrow brand tokens (sampled from the logo materials). BRAND green is
      // the chrome — buttons, active nav, links, accents. The DATA semantics
      // (text-green-700 favorable, red unfavorable, amber warning) stay on the
      // stock Tailwind palette so profit-green and brand-green never blur.
      colors: {
        brand: {
          DEFAULT: '#36B449', // kelly green — sampled from the OFFICIAL Brand.png
          deep: '#256F35',    // hover/pressed + link text (AA on white)
          dark: '#0B4A24',    // forest — top nav bar, headings accent
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
export default config
