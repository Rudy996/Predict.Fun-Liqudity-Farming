/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bnb: {
          DEFAULT: '#F7931A',
          light: '#FFB347',
          dark: '#E07B00',
          glow: 'rgba(247, 147, 26, 0.3)',
        },
        dark: {
          900: '#0D1117',
          800: '#161B22',
          700: '#21262D',
          600: '#30363D',
          500: '#484F58',
        },
        success: '#3FB950',
        danger: '#F85149',
        warning: '#D29922',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
        'card-in': 'cardIn 0.45s ease-out both',
        'price-flash': 'priceFlash 0.65s ease-out both',
        'shimmer-bg': 'shimmer-bg 3.2s ease-in-out infinite',
        'shimmer-sheen': 'shimmer-sheen 2.4s ease-in-out infinite',
      },
      keyframes: {
        'shimmer-bg': {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        'shimmer-sheen': {
          '0%': { transform: 'translateX(-100%) skewX(-12deg)' },
          '100%': { transform: 'translateX(200%) skewX(-12deg)' },
        },
        glow: {
          '0%': { boxShadow: '0 0 5px rgba(247, 147, 26, 0.2)' },
          '100%': { boxShadow: '0 0 20px rgba(247, 147, 26, 0.4)' },
        },
        cardIn: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        priceFlash: {
          '0%': { backgroundColor: 'rgba(247, 147, 26, 0.14)' },
          '100%': { backgroundColor: 'transparent' },
        },
      },
    },
  },
  plugins: [],
}
