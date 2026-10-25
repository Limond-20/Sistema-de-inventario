// Solo compila las clases que usa la página móvil.
module.exports = {
  content: [require('node:path').join(__dirname, '..', '..', 'abarrotes-app', 'public', 'movil-prototipo.html')],
  theme: { extend: {} },
  plugins: [],
};
