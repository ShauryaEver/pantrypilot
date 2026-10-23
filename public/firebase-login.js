// Firebase Auth (Google sign-in) loaded on demand, only when the server reports Firebase is configured.
// The browser only obtains a Google ID token; the SERVER verifies it and issues the real session cookie.
const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

export async function init(cfg) {
  const [{ initializeApp }, { getAuth, GoogleAuthProvider, signInWithPopup, signOut }] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
  ]);
  const auth = getAuth(initializeApp(cfg));
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return {
    /** Opens the Google popup and returns a fresh Firebase ID token. */
    async getIdToken() {
      const cred = await signInWithPopup(auth, provider);
      const token = await cred.user.getIdToken(true);
      await signOut(auth); // we keep our own HttpOnly session; no long-lived Firebase session in the browser
      return token;
    },
  };
}
