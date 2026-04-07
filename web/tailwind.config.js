/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        hull: {
          950: 'rgb(var(--hull-950) / <alpha-value>)',
          900: 'rgb(var(--hull-900) / <alpha-value>)',
          800: 'rgb(var(--hull-800) / <alpha-value>)',
          700: 'rgb(var(--hull-700) / <alpha-value>)',
          600: 'rgb(var(--hull-600) / <alpha-value>)',
        },
        neon: {
          green: 'rgb(var(--neon-green) / <alpha-value>)',
          amber: 'rgb(var(--neon-amber) / <alpha-value>)',
          red:   'rgb(var(--neon-red) / <alpha-value>)',
          blue:  'rgb(var(--neon-blue) / <alpha-value>)',
          cyan:  'rgb(var(--neon-cyan) / <alpha-value>)',
        },
        gray: {
          300: 'rgb(var(--gray-300) / <alpha-value>)',
          400: 'rgb(var(--gray-400) / <alpha-value>)',
          500: 'rgb(var(--gray-500) / <alpha-value>)',
          600: 'rgb(var(--gray-600) / <alpha-value>)',
          700: 'rgb(var(--gray-700) / <alpha-value>)',
        },
        white: 'rgb(var(--color-white) / <alpha-value>)',
      },
      fontFamily: { mono: ['"JetBrains Mono"', 'monospace'] },
    },
  },
  plugins: [],
}
