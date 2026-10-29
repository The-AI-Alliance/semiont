/** @type {import('tailwindcss').Config} */
module.exports = {
  // The mark react-ui's ThemeProvider puts on <html>.
  darkMode: ['selector', '[data-theme="dark"]'],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        'sky-blue': '#87CEEB',
      },
      fontFamily: {
        'orbitron': ['var(--font-orbitron)', 'monospace'],
      },
    },
  },
};
