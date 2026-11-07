// Solo compila las clases que usa la página móvil.
module.exports = {
  content: [require('node:path').join(__dirname, '..', '..', 'abarrotes-app', 'public', 'movil-prototipo.html')],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Figtree', 'Segoe UI', 'system-ui', 'sans-serif'],
        display: ['"Bricolage Grotesque"', 'Figtree', 'system-ui', 'sans-serif'],
        mono: ['Figtree', 'Segoe UI', 'system-ui', 'sans-serif'],
      },
      colors: {
        ok: '#34d399',
        brand: { 100: '#d6e7ea', 200: '#a9c4ca', 600: '#136075', 700: '#0e4a57', 800: '#0a3943', 900: '#072b33' },
        slate: { 50: '#f5f8f8', 100: '#eceff0', 200: '#dde3e4', 300: '#c5cfd1', 400: '#93a4a7', 500: '#667a7e', 600: '#4c6064', 700: '#344a4f', 800: '#1e343a', 900: '#12292f', 950: '#0b1d22' },
        emerald: { 50: '#eef6f7', 100: '#d6e7ea', 200: '#b3d2d8', 300: '#a6cdd5', 400: '#7cb4bf', 500: '#2a6f80', 600: '#0e4a57', 700: '#0b3d48', 800: '#0a3943', 900: '#072b33', 950: '#041d23' },
        blue: { 50: '#eef6f7', 100: '#d6e7ea', 200: '#b3d2d8', 300: '#a6cdd5', 400: '#7cb4bf', 500: '#2a6f80', 600: '#0e4a57', 700: '#0b3d48', 800: '#0a3943', 900: '#072b33', 950: '#041d23' },
        amber: { 50: '#fbf6ea', 100: '#f6ebcf', 200: '#edd8a3', 300: '#e2c070', 400: '#d9ad4c', 500: '#c48f2e', 600: '#a87722', 700: '#8a5f1b', 800: '#6f4b16', 900: '#563a13', 950: '#3a2709' },
        rose: { 50: '#fbf1f1', 100: '#f6e0e0', 200: '#ebc4c4', 300: '#dda0a0', 400: '#c97878', 500: '#b65a5a', 600: '#a33f3f', 700: '#8c3434', 800: '#702b2b', 900: '#571f1f', 950: '#3b1414' },
      },
    },
  },
  plugins: [],
};
