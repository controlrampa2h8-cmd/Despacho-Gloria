const firebaseConfig = {
  apiKey: "AIzaSyDs3UaJ1UUx0E4ChSpeOtr5BjqZSg1ni3Q",
  authDomain: "despachos-gloria.firebaseapp.com",
  projectId: "despachos-gloria",
  storageBucket: "despachos-gloria.firebasestorage.app",
  messagingSenderId: "481019430570",
  appId: "1:481019430570:web:41ce49958cbbb4405ef2d3"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Habilitar persistencia offline nativa (vital si pierde señal en almacén)
db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  console.warn("Persistencia offline:", err.code);
});
