/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        base: {
          950: '#0a0a0f',
          900: '#0f0f17',
          850: '#14141f',
          800: '#1a1a26',
          700: '#252534',
        },
        hush: {
          400: '#8b8fd8',
          500: '#6f74c9',
          600: '#585db3',
        },
      },
      fontFamily: {
        display: ['"Fraunces"', 'ui-serif', 'serif'],
        body: ['"Inter"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: 0, transform: 'translateY(6px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        },
        'pulse-once': {
          '0%': { transform: 'scale(1)' },
          '40%': { transform: 'scale(1.35)' },
          '100%': { transform: 'scale(1)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.35s ease-out',
        'pulse-once': 'pulse-once 0.4s ease-out',
      },
    },
  },
  plugins: [],
}
