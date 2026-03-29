/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        hull: { 950: '#060a13', 900: '#0a0e17', 800: '#111827', 700: '#1a2235', 600: '#243049' },
        neon: { green: '#00ff88', amber: '#ffb800', red: '#ff3355', blue: '#3b82f6', cyan: '#06d6e0' },
      },
      fontFamily: { mono: ['"JetBrains Mono"', 'monospace'] },
    },
  },
  plugins: [],
}
