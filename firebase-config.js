const firebaseConfig = {
  apiKey: "TU_API_KEY",
  authDomain: "TU_PROYECTO.firebaseapp.com",
  projectId: "TU_PROYECTO",
  storageBucket: "TU_PROYECTO.appspot.com",
  messagingSenderId: "TU_SENDER_ID",
  appId: "TU_APP_ID"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Habilitar persistencia offline nativa (vital si pierde señal en almacén)
db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  console.warn("Persistencia offline:", err.code);
});
